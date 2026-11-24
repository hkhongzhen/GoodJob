/**
 * 发信前邮箱验证路由：策略配置、单个/批量验证、缓存状态查询。
 * 验证结果按「团队 + 邮箱」存放；Key 只加密落库，接口永不回传明文。
 */
import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { setAppSetting } from "../app-settings.js";
import {
  EMAIL_VERIFICATION_POLICY_KEY,
  EMAIL_VERIFICATION_STATUSES,
  emailVerificationPolicyView,
  getEmailVerification,
  serializeEmailVerificationPolicy,
  setEmailVerificationPolicyRuntime,
  verifyEmail,
  type EmailVerificationRecord
} from "../email-verifier.js";
import { asyncRoute } from "../server-core.js";
import { getStore } from "../store.js";

const MAX_BATCH = 50;
const CONCURRENCY = 4;

const recordView = (record: EmailVerificationRecord) => ({
  email: record.email,
  status: record.status,
  provider: record.provider,
  isRole: record.isRole,
  isCatchAll: record.isCatchAll,
  isDisposable: record.isDisposable,
  reason: record.reason,
  checkedAt: record.checkedAt
});

const emailsSchema = z.array(z.string().trim().min(1).max(254)).min(1).max(MAX_BATCH);

export function registerEmailVerificationRoutes(app: Express) {
  app.get("/api/email-delivery/verification", requireAuth, asyncRoute(async (_req, res) => {
    res.json({ config: emailVerificationPolicyView() });
  }));

  app.put("/api/email-delivery/verification", requireAuth, asyncRoute(async (req, res) => {
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user || !["admin", "super_admin"].includes(user.role)) {
      res.status(403).json({ message: "只有管理员可以调整邮箱验证设置" });
      return;
    }
    const body = z.object({
      enabled: z.boolean(),
      provider: z.enum(["none", "zerobounce", "neverbounce", "reoon"]),
      apiKey: z.string().trim().max(300).optional(),
      staleDays: z.number().int().min(1).max(365),
      blockStatuses: z.array(z.enum(EMAIL_VERIFICATION_STATUSES as [string, ...string[]])).max(EMAIL_VERIFICATION_STATUSES.length),
      requireVerified: z.boolean()
    }).parse(req.body || {});
    const raw = serializeEmailVerificationPolicy({
      ...body,
      blockStatuses: body.blockStatuses as never,
      // 留空表示沿用已保存的 Key；选择 none 时清除
      apiKey: body.provider === "none" ? "" : body.apiKey || undefined
    });
    await setAppSetting(EMAIL_VERIFICATION_POLICY_KEY, raw);
    setEmailVerificationPolicyRuntime(raw);
    res.json({ config: emailVerificationPolicyView() });
  }));

  app.post("/api/email-verifications/lookup", requireAuth, asyncRoute(async (req, res) => {
    const { emails } = z.object({ emails: emailsSchema }).parse(req.body || {});
    const results = emails.flatMap((email) => {
      const record = getEmailVerification(req.user!.teamId, email);
      return record ? [recordView(record)] : [];
    });
    res.json({ results });
  }));

  app.post("/api/email-verifications/verify", requireAuth, asyncRoute(async (req, res) => {
    const { emails, force } = z.object({ emails: emailsSchema, force: z.boolean().optional() }).parse(req.body || {});
    const unique = [...new Set(emails.map((item) => item.toLowerCase()))];
    const results: ReturnType<typeof recordView>[] = [];
    const errors: Array<{ email: string; message: string }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < unique.length) {
        const email = unique[cursor++];
        try {
          results.push(recordView(await verifyEmail(req.user!.teamId, email, { force })));
        } catch (error) {
          errors.push({ email, message: error instanceof Error ? error.message : "验证失败" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
    res.json({ results, errors });
  }));
}
