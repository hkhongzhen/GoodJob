import { randomUUID } from "node:crypto";
import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import type { Pool } from "mysql2/promise";
import { decryptMailCredential, encryptMailCredential } from "./credential-security.js";

// ---------------------------------------------------------------------------
// 发信前邮箱验证（移植自 Arlo 的 Verify emails）
// 两级：免费预筛（语法 / MX / 一次性域名 / 角色前缀）+ 可选第三方 API（ZeroBounce / NeverBounce）。
// 结果按「团队 + 邮箱」存放，候选 / 线索 / 客户共用；独立小表 + 模块级仓库，不进 persistAll。
// ---------------------------------------------------------------------------

export type EmailVerificationStatus =
  | "DELIVERABLE"
  | "DOMAIN_VALID"
  | "INVALID"
  | "CATCH_ALL"
  | "DISPOSABLE"
  | "ROLE"
  | "UNKNOWN";

export const EMAIL_VERIFICATION_STATUSES: EmailVerificationStatus[] = [
  "DELIVERABLE", "DOMAIN_VALID", "INVALID", "CATCH_ALL", "DISPOSABLE", "ROLE", "UNKNOWN"
];

export type EmailVerificationProvider = "none" | "zerobounce" | "neverbounce" | "reoon";

export interface EmailVerificationRecord {
  id: string;
  teamId: string;
  email: string;
  status: EmailVerificationStatus;
  provider: string;
  isRole: boolean;
  isCatchAll: boolean;
  isDisposable: boolean;
  reason: string;
  checkedAt: string;
  staleAfter: string;
}

export const EMAIL_VERIFICATION_POLICY_KEY = "email_verification_policy";

export interface EmailVerificationPolicy {
  enabled: boolean;
  provider: EmailVerificationProvider;
  apiKey: string;
  staleDays: number;
  blockStatuses: EmailVerificationStatus[];
  requireVerified: boolean;
}

export const DEFAULT_EMAIL_VERIFICATION_POLICY: EmailVerificationPolicy = {
  enabled: true,
  provider: "none",
  apiKey: "",
  staleDays: 30,
  blockStatuses: ["INVALID", "DISPOSABLE"],
  requireVerified: false
};

const SECRET_CONTEXT = { id: "email-verification", teamId: "global", kind: "verifier" } as const;
const ROLE_RE = /^(info|sales|support|contact|admin|office|hello|help|team|billing|accounts|noreply|no-reply)$/i;
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)*\.[A-Z]{2,}$/i;
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "10minutemail.net",
  "tempmail.com", "temp-mail.org", "temp-mail.io", "throwawaymail.com", "yopmail.com", "yopmail.net",
  "trashmail.com", "getnada.com", "sharklasers.com", "maildrop.cc", "dispostable.com", "fakeinbox.com",
  "mailnesia.com", "mintemail.com", "moakt.com", "emailondeck.com", "tempinbox.com", "burnermail.io"
]);
const API_TIMEOUT_MS = 25_000;
const REOON_TIMEOUT_MS = 90_000;

// ── 策略（app_settings 存 JSON，apiKey 加密落库） ──────────────────────────
let policyRuntime: Partial<EmailVerificationPolicy> | null = null;

function normalizePolicy(raw: Partial<EmailVerificationPolicy> | null): EmailVerificationPolicy {
  const base = DEFAULT_EMAIL_VERIFICATION_POLICY;
  if (!raw) return { ...base, blockStatuses: [...base.blockStatuses] };
  const staleDays = Math.floor(Number(raw.staleDays));
  const provider = ["none", "zerobounce", "neverbounce", "reoon"].includes(String(raw.provider))
    ? raw.provider as EmailVerificationProvider
    : base.provider;
  const blockStatuses = Array.isArray(raw.blockStatuses)
    ? raw.blockStatuses.filter((item): item is EmailVerificationStatus => EMAIL_VERIFICATION_STATUSES.includes(item))
    : base.blockStatuses;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    provider,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    staleDays: Number.isFinite(staleDays) && staleDays > 0 ? Math.min(staleDays, 365) : base.staleDays,
    blockStatuses,
    requireVerified: typeof raw.requireVerified === "boolean" ? raw.requireVerified : base.requireVerified
  };
}

/** 启动时 / 保存后调用：传 app_settings 里的 JSON（apiKey 为密文）；空串或坏数据回落默认值 */
export function setEmailVerificationPolicyRuntime(raw: string) {
  if (!raw.trim()) { policyRuntime = null; return; }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") { policyRuntime = null; return; }
    let apiKey = "";
    try { apiKey = decryptMailCredential(SECRET_CONTEXT, String(parsed.apiKey || "")); } catch { apiKey = ""; }
    policyRuntime = { ...parsed, apiKey };
  } catch {
    policyRuntime = null;
  }
}

export function emailVerificationPolicy(): EmailVerificationPolicy {
  return normalizePolicy(policyRuntime);
}

/** 序列化为可落库的 JSON（apiKey 加密）；apiKey 传 undefined 表示沿用当前已存的 Key */
export function serializeEmailVerificationPolicy(
  input: Omit<EmailVerificationPolicy, "apiKey"> & { apiKey?: string }
) {
  const apiKey = input.apiKey === undefined ? emailVerificationPolicy().apiKey : input.apiKey.trim();
  return JSON.stringify({ ...input, apiKey: encryptMailCredential(SECRET_CONTEXT, apiKey) });
}

/** 返回给前端的视图：永不包含明文 Key */
export function emailVerificationPolicyView() {
  const { apiKey, ...rest } = emailVerificationPolicy();
  return { ...rest, apiKeyConfigured: Boolean(apiKey) };
}

// ── 结果仓库：内存缓存（同步读）+ 可选 MySQL 写穿 ─────────────────────────
const cache = new Map<string, EmailVerificationRecord>();
let poolRef: Pool | null = null;

const cacheKey = (teamId: string, email: string) => `${teamId}|${email.trim().toLowerCase()}`;

export function ensureEmailVerificationSchema(pool: Pool) {
  return pool.query(`CREATE TABLE IF NOT EXISTS email_verifications (
    id VARCHAR(64) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    email VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL,
    provider VARCHAR(30) NOT NULL,
    is_role TINYINT(1) NOT NULL DEFAULT 0,
    is_catch_all TINYINT(1) NOT NULL DEFAULT 0,
    is_disposable TINYINT(1) NOT NULL DEFAULT 0,
    reason VARCHAR(500) DEFAULT '',
    checked_at DATETIME(3) NOT NULL,
    stale_after DATETIME(3) NOT NULL,
    UNIQUE KEY uniq_email_verification(team_id,email)
  )`);
}

export async function setEmailVerificationPool(pool: Pool | null) {
  poolRef = pool;
  cache.clear();
  if (!pool) return;
  const [rows] = await pool.query("SELECT * FROM email_verifications");
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
  for (const row of rows as Record<string, any>[]) {
    cache.set(cacheKey(row.team_id, row.email), {
      id: row.id,
      teamId: row.team_id,
      email: row.email,
      status: row.status,
      provider: row.provider,
      isRole: Boolean(row.is_role),
      isCatchAll: Boolean(row.is_catch_all),
      isDisposable: Boolean(row.is_disposable),
      reason: row.reason || "",
      checkedAt: iso(row.checked_at),
      staleAfter: iso(row.stale_after)
    });
  }
}

async function saveRecord(record: EmailVerificationRecord) {
  cache.set(cacheKey(record.teamId, record.email), record);
  if (!poolRef) return;
  await poolRef.query(
    `INSERT INTO email_verifications (id,team_id,email,status,provider,is_role,is_catch_all,is_disposable,reason,checked_at,stale_after)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status),provider=VALUES(provider),is_role=VALUES(is_role),
       is_catch_all=VALUES(is_catch_all),is_disposable=VALUES(is_disposable),reason=VALUES(reason),
       checked_at=VALUES(checked_at),stale_after=VALUES(stale_after)`,
    [
      record.id, record.teamId, record.email, record.status, record.provider,
      record.isRole ? 1 : 0, record.isCatchAll ? 1 : 0, record.isDisposable ? 1 : 0, record.reason,
      new Date(record.checkedAt), new Date(record.staleAfter)
    ]
  );
}

/** 同步读取缓存：用于资格灯等不能 await 的场景；过期记录视为不存在 */
export function getEmailVerification(teamId: string, email: string, now = Date.now()) {
  const record = cache.get(cacheKey(teamId, email));
  return record && new Date(record.staleAfter).getTime() > now ? record : undefined;
}

export function resetEmailVerificationForTest() {
  cache.clear();
  policyRuntime = null;
  poolRef = null;
  fetchImpl = fetch;
  dnsImpl = defaultDns;
}

// ── 预筛（免费） ──────────────────────────────────────────────────────────
export interface DnsLookup {
  mx(domain: string): Promise<Array<{ exchange: string }>>;
  hasAddress(domain: string): Promise<boolean>;
}

const defaultDns: DnsLookup = {
  mx: (domain) => resolveMx(domain),
  async hasAddress(domain) {
    const results = await Promise.allSettled([resolve4(domain), resolve6(domain)]);
    return results.some((item) => item.status === "fulfilled" && item.value.length > 0);
  }
};
let dnsImpl: DnsLookup = defaultDns;
let fetchImpl: typeof fetch = fetch;

export function setEmailVerifierDepsForTest(deps: { dns?: DnsLookup; fetch?: typeof fetch }) {
  if (deps.dns) dnsImpl = deps.dns;
  if (deps.fetch) fetchImpl = deps.fetch;
}

const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA", "ENOENT"]);
const errorCode = (error: unknown) => String((error as { code?: unknown })?.code || "");

export interface PrecheckResult {
  status: EmailVerificationStatus;
  isRole: boolean;
  isDisposable: boolean;
  reason: string;
}

export async function precheckEmail(rawEmail: string): Promise<PrecheckResult> {
  const email = rawEmail.trim().toLowerCase();
  const [local = "", domain = ""] = email.split("@");
  const isRole = ROLE_RE.test(local);
  if (!EMAIL_RE.test(email) || email.length > 254 || local.length > 64) {
    return { status: "INVALID", isRole, isDisposable: false, reason: "邮箱格式不正确" };
  }
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { status: "DISPOSABLE", isRole, isDisposable: true, reason: "一次性邮箱域名" };
  }
  try {
    const records = await dnsImpl.mx(domain);
    const usable = records.filter((item) => item.exchange && item.exchange !== ".");
    if (usable.length) return { status: "DOMAIN_VALID", isRole, isDisposable: false, reason: "域名可收信（MX 存在），邮箱本身未确认" };
    if (records.length) return { status: "INVALID", isRole, isDisposable: false, reason: "域名声明不接收邮件（Null MX）" };
  } catch (error) {
    if (!NO_RECORD_CODES.has(errorCode(error))) {
      return { status: "UNKNOWN", isRole, isDisposable: false, reason: `DNS 查询失败（${errorCode(error) || "未知错误"}），请稍后重试` };
    }
  }
  try {
    if (await dnsImpl.hasAddress(domain)) {
      return { status: "DOMAIN_VALID", isRole, isDisposable: false, reason: "域名无 MX 记录，但有 A/AAAA 记录，可能可收信" };
    }
  } catch {
    return { status: "UNKNOWN", isRole, isDisposable: false, reason: "DNS 查询失败，请稍后重试" };
  }
  return { status: "INVALID", isRole, isDisposable: false, reason: "域名没有 MX 或 A 记录，无法收信" };
}

// ── 第三方 API ────────────────────────────────────────────────────────────
interface ApiOutcome {
  status: EmailVerificationStatus;
  isRole: boolean;
  isCatchAll: boolean;
  isDisposable: boolean;
  reason: string;
}

async function getJson(url: string, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应按错误处理 */ }
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

/** 把各家词汇映射为统一状态（沿用 Arlo 的 mapStatus） */
export function mapProviderStatus(raw: string, catchAll: boolean): EmailVerificationStatus {
  const v = (raw || "").toLowerCase();
  if (catchAll || v.includes("catch")) return "CATCH_ALL";
  if (["undeliverable", "invalid", "bad", "rejected", "do_not_mail", "spamtrap", "abuse"].some((x) => v.includes(x))) return "INVALID";
  if (["deliverable", "valid", "ok", "safe"].some((x) => v.includes(x))) return "DELIVERABLE";
  if (v.includes("disposable")) return "DISPOSABLE";
  if (v.includes("role")) return "ROLE";
  return "UNKNOWN";
}

async function callZeroBounce(apiKey: string, email: string, isRoleLocal: boolean): Promise<ApiOutcome> {
  const { res, json } = await getJson(
    `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  );
  if (!res.ok || !json || json.error) throw new Error(`ZeroBounce 调用失败：${json?.error || res.status}`);
  const catchAll = json.status === "catch-all" || json.sub_status === "catch_all";
  const disposable = json.sub_status === "disposable";
  return {
    status: disposable ? "DISPOSABLE" : mapProviderStatus(String(json.status || ""), catchAll),
    isRole: json.sub_status === "role_based" || isRoleLocal,
    isCatchAll: catchAll,
    isDisposable: disposable,
    reason: `ZeroBounce: ${json.status}${json.sub_status ? `/${json.sub_status}` : ""}`
  };
}

async function callNeverBounce(apiKey: string, email: string, isRoleLocal: boolean): Promise<ApiOutcome> {
  const { res, json } = await getJson(
    `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  );
  if (!res.ok || json?.status !== "success") throw new Error(`NeverBounce 调用失败：${json?.message || res.status}`);
  const result = String(json.result || "");
  return {
    status: mapProviderStatus(result, result === "catchall"),
    isRole: isRoleLocal,
    isCatchAll: result === "catchall",
    isDisposable: result === "disposable",
    reason: `NeverBounce: ${result}`
  };
}

/** Reoon power 模式状态映射：能逐个检查收件箱是否存在（慢，可达 1 分钟） */
export function mapReoonStatus(raw: string): EmailVerificationStatus {
  switch ((raw || "").toLowerCase()) {
    case "safe": return "DELIVERABLE";
    case "invalid": case "disabled": case "spamtrap": return "INVALID";
    case "disposable": return "DISPOSABLE";
    case "catch_all": return "CATCH_ALL";
    case "role_account": return "ROLE";
    default: return "UNKNOWN"; // unknown / inbox_full / 其它
  }
}

async function callReoon(apiKey: string, email: string, isRoleLocal: boolean): Promise<ApiOutcome> {
  const { res, json } = await getJson(
    `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`,
    REOON_TIMEOUT_MS
  );
  if (!res.ok || !json || json.status === "error" || (!json.status && json.reason)) {
    throw new Error(`Reoon 调用失败：${json?.reason || json?.message || res.status}`);
  }
  const status = mapReoonStatus(String(json.status || ""));
  return {
    status,
    isRole: Boolean(json.is_role_account) || isRoleLocal,
    isCatchAll: Boolean(json.is_catch_all) || status === "CATCH_ALL",
    isDisposable: Boolean(json.is_disposable) || status === "DISPOSABLE",
    reason: `Reoon: ${json.status}${typeof json.overall_score === "number" ? `（评分 ${json.overall_score}）` : ""}`
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
/**
 * 验证单个邮箱：命中未过期缓存则直接返回（避免重复计费）；
 * 否则先预筛，明确无效 / 一次性不再花钱调 API；通过且配置了 Key 时再调第三方。
 */
export async function verifyEmail(
  teamId: string,
  rawEmail: string,
  options: { force?: boolean; precheckOnly?: boolean } = {}
): Promise<EmailVerificationRecord> {
  const email = rawEmail.trim().toLowerCase();
  const policy = emailVerificationPolicy();
  const apiConfigured = policy.provider !== "none" && Boolean(policy.apiKey);
  if (!options.force) {
    const cached = getEmailVerification(teamId, email);
    // 自动预筛留下的 precheck 记录不算「已用第三方验证」：手动验证且已配 Key 时要补调 API
    if (cached && (options.precheckOnly || !(cached.provider === "precheck" && apiConfigured))) return cached;
  }
  const pre = await precheckEmail(email);
  let outcome: ApiOutcome = {
    status: pre.status,
    isRole: pre.isRole,
    isCatchAll: false,
    isDisposable: pre.isDisposable,
    reason: pre.reason
  };
  let provider = "precheck";
  if (!options.precheckOnly && pre.status === "DOMAIN_VALID" && apiConfigured) {
    outcome = policy.provider === "zerobounce"
      ? await callZeroBounce(policy.apiKey, email, pre.isRole)
      : policy.provider === "reoon"
        ? await callReoon(policy.apiKey, email, pre.isRole)
        : await callNeverBounce(policy.apiKey, email, pre.isRole);
    provider = policy.provider;
  }
  const now = Date.now();
  const record: EmailVerificationRecord = {
    id: cache.get(cacheKey(teamId, email))?.id || randomUUID(),
    teamId,
    email,
    status: outcome.status,
    provider,
    isRole: outcome.isRole,
    isCatchAll: outcome.isCatchAll,
    isDisposable: outcome.isDisposable,
    reason: outcome.reason.slice(0, 500),
    checkedAt: new Date(now).toISOString(),
    // UNKNOWN 多为 DNS 临时故障，缩短有效期以便尽快重试
    staleAfter: new Date(now + (outcome.status === "UNKNOWN" ? 3_600_000 : policy.staleDays * 86_400_000)).toISOString()
  };
  await saveRecord(record);
  return record;
}

export const EMAIL_VERIFICATION_STATUS_LABELS: Record<EmailVerificationStatus, string> = {
  DELIVERABLE: "已验证有效",
  DOMAIN_VALID: "域名有效",
  INVALID: "邮箱无效",
  CATCH_ALL: "全收域名",
  DISPOSABLE: "一次性邮箱",
  ROLE: "角色邮箱",
  UNKNOWN: "无法确认"
};

/** 按策略判断该邮箱当前是否应被拦截；返回 null 表示放行（同步，仅读缓存） */
export function emailVerificationBlockReason(teamId: string, email: string): string | null {
  const policy = emailVerificationPolicy();
  if (!policy.enabled) return null;
  const record = getEmailVerification(teamId, email);
  if (!record) return policy.requireVerified ? "该邮箱尚未验证" : null;
  if (policy.blockStatuses.includes(record.status)) {
    return `${EMAIL_VERIFICATION_STATUS_LABELS[record.status]}（${record.reason}）`;
  }
  return null;
}

/** 发信前守卫：requireVerified 时自动触发一次验证；未启用或无记录且不强制时放行 */
export async function assertEmailVerifiedForSend(teamId: string, email: string) {
  const policy = emailVerificationPolicy();
  if (!policy.enabled) return;
  const known = getEmailVerification(teamId, email);
  const needsApi = known?.provider === "precheck" && policy.provider !== "none" && Boolean(policy.apiKey);
  if (policy.requireVerified && (!known || needsApi)) {
    try {
      await verifyEmail(teamId, email);
    } catch (error) {
      throw new Error(`发信保护：邮箱验证服务暂不可用，无法确认 ${email}（${error instanceof Error ? error.message : "未知错误"}）`);
    }
  }
  const reason = emailVerificationBlockReason(teamId, email);
  if (reason) throw new Error(`发信保护：收件邮箱 ${email} 未通过验证 —— ${reason}`);
}

// ── 自动预筛：搜出候选后默认只做免费预筛（不调第三方 API） ─────────────────
const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_AUTO_PRECHECK = 100;
const inFlight = new Map<string, Promise<unknown>>();

export function candidateEmailAddresses(item: {
  contactInfo?: string; contact?: string; lastDevelopmentEmailTo?: string;
  extractedContacts?: Array<{ emails?: string[] }>;
}) {
  const text = [
    item.lastDevelopmentEmailTo, item.contactInfo, item.contact,
    ...(item.extractedContacts || []).flatMap((contact) => contact.emails || [])
  ].filter(Boolean).join(" ");
  return [...new Set((text.match(EMAIL_IN_TEXT) || []).map((email) => email.toLowerCase()))];
}

/** 对尚无结果的邮箱做免费预筛；已有未过期结果或正在预筛的跳过。返回的 Promise 不会 reject */
export function autoPrecheckEmails(teamId: string, emails: string[]): Promise<void> {
  if (!emailVerificationPolicy().enabled) return Promise.resolve();
  const todo = [...new Set(emails.map((email) => email.trim().toLowerCase()))]
    .filter((email) => email && !getEmailVerification(teamId, email))
    .slice(0, MAX_AUTO_PRECHECK);
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const email = todo[cursor++];
      const key = cacheKey(teamId, email);
      let task = inFlight.get(key);
      if (!task) {
        task = verifyEmail(teamId, email, { precheckOnly: true })
          .catch(() => undefined)
          .finally(() => inFlight.delete(key));
        inFlight.set(key, task);
      }
      await task;
    }
  };
  return Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker)).then(() => undefined);
}
