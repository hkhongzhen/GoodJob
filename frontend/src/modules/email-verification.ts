/**
 * 发信前邮箱验证：状态徽标、单个/批量验证、AI 配置页的验证策略配置。
 * 后端见 backend/src/email-verifier.ts；结果按「团队 + 邮箱」缓存。
 */
import { badge, escapeHtml, qs, qsa, setFieldValue } from "./shared";
import { api, setButtonPending, toast } from "./ui";

export type EmailVerificationStatus =
  | "DELIVERABLE" | "DOMAIN_VALID" | "INVALID" | "CATCH_ALL" | "DISPOSABLE" | "ROLE" | "UNKNOWN";

export interface EmailVerificationResult {
  email: string;
  status: EmailVerificationStatus;
  provider: string;
  isRole: boolean;
  isCatchAll: boolean;
  isDisposable: boolean;
  reason: string;
  checkedAt: string;
}

const STATUS_META: Record<EmailVerificationStatus, { label: string; tone: string }> = {
  DELIVERABLE: { label: "已验证有效", tone: "green" },
  DOMAIN_VALID: { label: "域名有效", tone: "green" },
  INVALID: { label: "邮箱无效", tone: "red" },
  CATCH_ALL: { label: "全收域名", tone: "amber" },
  DISPOSABLE: { label: "一次性邮箱", tone: "red" },
  ROLE: { label: "角色邮箱", tone: "amber" },
  UNKNOWN: { label: "无法确认", tone: "amber" }
};

export function emailVerificationBadge(result?: EmailVerificationResult | null) {
  if (!result) return badge("未验证", "gray");
  const meta = STATUS_META[result.status] || STATUS_META.UNKNOWN;
  const role = result.isRole && result.status !== "ROLE" ? " · 角色" : "";
  return `<span title="${escapeHtml(result.reason)}">${badge(`${meta.label}${role}`, meta.tone)}</span>`;
}

export async function lookupEmailVerifications(emails: string[]) {
  const unique = [...new Set(emails.map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
  if (!unique.length) return new Map<string, EmailVerificationResult>();
  const { results } = await api<{ results: EmailVerificationResult[] }>("/api/email-verifications/lookup", {
    method: "POST",
    body: JSON.stringify({ emails: unique })
  });
  return new Map(results.map((item) => [item.email, item]));
}

/** 验证并 toast 汇总；超过 50 个按批切分 */
export async function verifyEmails(emails: string[], force = false) {
  const unique = [...new Set(emails.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const results: EmailVerificationResult[] = [];
  const errors: Array<{ email: string; message: string }> = [];
  for (let index = 0; index < unique.length; index += 50) {
    const chunk = await api<{ results: EmailVerificationResult[]; errors: Array<{ email: string; message: string }> }>(
      "/api/email-verifications/verify",
      { method: "POST", body: JSON.stringify({ emails: unique.slice(index, index + 50), force }) }
    );
    results.push(...chunk.results);
    errors.push(...chunk.errors);
  }
  return { results, errors };
}

export function summarizeVerification(results: EmailVerificationResult[], errors: Array<{ email: string; message: string }>) {
  const bad = results.filter((item) => item.status === "INVALID" || item.status === "DISPOSABLE").length;
  const risky = results.filter((item) => ["CATCH_ALL", "UNKNOWN", "ROLE"].includes(item.status)).length;
  const good = results.length - bad - risky;
  return `已验证 ${results.length} 个：有效 ${good}，无效/一次性 ${bad}，风险 ${risky}${errors.length ? `，失败 ${errors.length}（${errors[0].message}）` : ""}`;
}

/** 单个邮箱验证按钮 + 徽标：点击验证，完成后原位刷新徽标 */
export function emailVerifyControlHtml(email: string) {
  return `<span class="email-verify-control" data-email-verify-box="${escapeHtml(email.toLowerCase())}"><span data-email-verify-badge>${badge("未验证", "gray")}</span> <button class="btn" type="button" data-email-verify-button>验证</button></span>`;
}

export async function bindEmailVerifyControls(root: HTMLElement) {
  const boxes = Array.from(root.querySelectorAll<HTMLElement>("[data-email-verify-box]"));
  if (!boxes.length) return;
  const emails = boxes.map((box) => box.dataset.emailVerifyBox || "");
  try {
    const known = await lookupEmailVerifications(emails);
    boxes.forEach((box) => {
      const slot = box.querySelector<HTMLElement>("[data-email-verify-badge]");
      if (slot) slot.innerHTML = emailVerificationBadge(known.get(box.dataset.emailVerifyBox || ""));
    });
  } catch { /* 状态读取失败按未验证展示 */ }
  boxes.forEach((box) => {
    const button = box.querySelector<HTMLButtonElement>("[data-email-verify-button]");
    button?.addEventListener("click", async () => {
      const email = box.dataset.emailVerifyBox || "";
      setButtonPending(button, true, "验证", "验证中");
      try {
        const { results, errors } = await verifyEmails([email], true);
        const slot = box.querySelector<HTMLElement>("[data-email-verify-badge]");
        if (slot && results[0]) slot.innerHTML = emailVerificationBadge(results[0]);
        if (errors.length) toast(errors[0].message, "error");
        else if (results[0]) toast(`${email}：${results[0].reason}`, ["INVALID", "DISPOSABLE"].includes(results[0].status) ? "error" : "success");
      } catch (error) {
        toast(error instanceof Error ? error.message : "邮箱验证失败", "error");
      } finally {
        setButtonPending(button, false, "验证", "验证中");
      }
    });
  });
}

// ── 邮箱设置 → 邮箱验证 ───────────────────────────────────────────────────
interface VerificationConfigView {
  enabled: boolean;
  provider: "none" | "zerobounce" | "neverbounce" | "reoon";
  apiKeyConfigured: boolean;
  staleDays: number;
  blockStatuses: EmailVerificationStatus[];
  requireVerified: boolean;
}

const BLOCKABLE: EmailVerificationStatus[] = ["INVALID", "DISPOSABLE", "CATCH_ALL", "UNKNOWN", "ROLE"];

function renderVerificationConfig(config: VerificationConfigView) {
  const enabled = qs<HTMLInputElement>("#emailVerifyEnabled");
  if (enabled) enabled.checked = config.enabled;
  const require = qs<HTMLInputElement>("#emailVerifyRequire");
  if (require) require.checked = config.requireVerified;
  setFieldValue("#emailVerifyProvider", config.provider === "none" ? "" : config.provider);
  setFieldValue("#emailVerifyStaleDays", String(config.staleDays));
  setFieldValue("#emailVerifyApiKey", "");
  const key = qs<HTMLInputElement>("#emailVerifyApiKey");
  if (key) key.placeholder = config.apiKeyConfigured ? "已保存（留空保持不变）" : "第三方验证服务的 API Key";
  BLOCKABLE.forEach((status) => {
    const box = qs<HTMLInputElement>(`[data-email-verify-block="${status}"]`);
    if (box) box.checked = config.blockStatuses.includes(status);
  });
  const status = qs<HTMLElement>("#emailVerifyStatus");
  if (status) {
    status.innerHTML = !config.enabled
      ? badge("已关闭", "gray")
      : config.provider !== "none" && config.apiKeyConfigured
        ? badge(`预筛 + ${({ zerobounce: "ZeroBounce", neverbounce: "NeverBounce", reoon: "Reoon" } as Record<string, string>)[config.provider]}`, "green")
        : badge("仅免费预筛（语法 / MX / 一次性）", "amber");
  }
}

export async function loadEmailVerificationConfig(canManage: boolean) {
  const panel = qs<HTMLElement>('[data-ai-settings-panel="verification"]');
  const status = qs<HTMLElement>("#emailVerifyStatus");
  if (!panel || !status) return;
  const controls = qsa<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button", panel);
  controls.forEach((control) => { control.disabled = true; });
  try {
    renderVerificationConfig((await api<{ config: VerificationConfigView }>("/api/email-delivery/verification")).config);
    if (canManage) controls.forEach((control) => { control.disabled = false; });
  } catch (error) {
    status.innerHTML = `${badge("读取失败", "amber")} <small>${escapeHtml(error instanceof Error ? error.message : "未知错误")}</small>`;
  }
}

export async function saveEmailVerificationConfig(button?: HTMLButtonElement | null) {
  const staleDays = Math.round(Number(qs<HTMLInputElement>("#emailVerifyStaleDays")?.value || 30));
  if (!(staleDays >= 1 && staleDays <= 365)) { toast("验证有效期需在 1–365 天之间", "error"); return; }
  const provider = (qs<HTMLSelectElement>("#emailVerifyProvider")?.value || "none") as VerificationConfigView["provider"];
  const apiKey = qs<HTMLInputElement>("#emailVerifyApiKey")?.value.trim() || "";
  if (apiKey && provider === "none") {
    toast("请先选择第三方验证服务", "error");
    return;
  }
  const blockStatuses = BLOCKABLE.filter((status) => qs<HTMLInputElement>(`[data-email-verify-block="${status}"]`)?.checked);
  setButtonPending(button ?? null, true, "保存", "保存中");
  try {
    const { config } = await api<{ config: VerificationConfigView }>("/api/email-delivery/verification", {
      method: "PUT",
      body: JSON.stringify({
        enabled: qs<HTMLInputElement>("#emailVerifyEnabled")?.checked ?? true,
        provider,
        ...(apiKey ? { apiKey } : {}),
        staleDays,
        blockStatuses,
        requireVerified: qs<HTMLInputElement>("#emailVerifyRequire")?.checked ?? false
      })
    });
    renderVerificationConfig(config);
    toast("邮箱验证设置已保存，立即生效", "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存邮箱验证设置失败", "error");
  } finally {
    setButtonPending(button ?? null, false, "保存", "保存中");
  }
}

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** 从搜客候选里收集所有可能的收件邮箱（与后端资格灯同一批来源） */
export function candidateEmails(item: {
  contactInfo?: string; contact?: string; lastDevelopmentEmailTo?: string;
  extractedContacts?: Array<{ emails?: string[] }>;
  emailEligibility?: { recipient?: string };
}) {
  const text = [
    item.emailEligibility?.recipient, item.lastDevelopmentEmailTo, item.contactInfo, item.contact,
    ...(item.extractedContacts || []).flatMap((contact) => contact.emails || [])
  ].filter(Boolean).join(" ");
  return [...new Set((text.match(EMAIL_IN_TEXT) || []).map((email) => email.toLowerCase()))];
}

// ── 开发信工作区「收件邮箱」旁的验证按钮与状态 ──────────────────────────────
let mailToVerifyBound = false;
let mailToVerifyTimer: number | undefined;
let mailToVerifySeq = 0;

function mailToEmail() {
  return (qs<HTMLInputElement>("#prospectMailTo")?.value || "").trim().toLowerCase();
}

/** 按输入框当前邮箱查缓存并显示状态；已验证过直接展示，未验证显示"未验证" */
export async function refreshMailToVerify() {
  const box = qs<HTMLElement>("#prospectMailVerifyStatus");
  const input = qs<HTMLInputElement>("#prospectMailTo");
  if (!box || !input) return;
  if (!mailToVerifyBound) {
    mailToVerifyBound = true;
    input.addEventListener("input", () => {
      window.clearTimeout(mailToVerifyTimer);
      mailToVerifyTimer = window.setTimeout(() => void refreshMailToVerify(), 400);
    });
    const button = qs<HTMLButtonElement>("#prospectMailVerifyButton");
    button?.addEventListener("click", async () => {
      const email = mailToEmail();
      if (!email) { toast("请先填写收件邮箱", "error"); return; }
      setButtonPending(button, true, "验证", "验证中");
      try {
        const { results, errors } = await verifyEmails([email], true);
        if (errors.length) toast(errors[0].message, "error");
        else if (results[0]) toast(`${email}：${results[0].reason}`, ["INVALID", "DISPOSABLE"].includes(results[0].status) ? "error" : "success");
        await refreshMailToVerify();
      } catch (error) {
        toast(error instanceof Error ? error.message : "邮箱验证失败", "error");
      } finally {
        setButtonPending(button, false, "验证", "验证中");
      }
    });
  }
  const email = mailToEmail();
  if (!email) { box.innerHTML = ""; return; }
  const seq = ++mailToVerifySeq;
  try {
    const known = await lookupEmailVerifications([email]);
    if (seq !== mailToVerifySeq) return;
    const record = known.get(email);
    box.innerHTML = `${emailVerificationBadge(record)}${record ? ` <small>${escapeHtml(record.reason)}</small>` : ""}`;
  } catch {
    if (seq === mailToVerifySeq) box.innerHTML = "";
  }
}
