import assert from "node:assert/strict";
import {
  assertEmailVerifiedForSend,
  autoPrecheckEmails,
  candidateEmailAddresses,
  emailVerificationBlockReason,
  emailVerificationPolicy,
  emailVerificationPolicyView,
  getEmailVerification,
  mapProviderStatus,
  mapReoonStatus,
  precheckEmail,
  resetEmailVerificationForTest,
  serializeEmailVerificationPolicy,
  setEmailVerificationPolicyRuntime,
  setEmailVerifierDepsForTest,
  verifyEmail
} from "./email-verifier.js";

const team = "team_a";
const noRecord = Object.assign(new Error("nx"), { code: "ENOTFOUND" });
let mxCalls = 0;
const dns = {
  async mx(domain: string) {
    mxCalls++;
    if (domain === "good.com") return [{ exchange: "mx.good.com" }];
    if (domain === "nullmx.com") return [{ exchange: "." }];
    if (domain === "flaky.com") throw Object.assign(new Error("t"), { code: "ETIMEOUT" });
    throw noRecord;
  },
  async hasAddress(domain: string) { return domain === "aonly.com"; }
};
let apiBody: Record<string, unknown> = { status: "valid" };
let apiCalls = 0;
const fakeFetch = (async () => {
  apiCalls++;
  return new Response(JSON.stringify(apiBody), { status: 200 });
}) as unknown as typeof fetch;

resetEmailVerificationForTest();
setEmailVerifierDepsForTest({ dns, fetch: fakeFetch });

// 预筛
assert.equal((await precheckEmail("not-an-email")).status, "INVALID");
assert.equal((await precheckEmail("a@mailinator.com")).status, "DISPOSABLE");
assert.equal((await precheckEmail("a@nullmx.com")).status, "INVALID");
assert.equal((await precheckEmail("a@missing.com")).status, "INVALID");
assert.equal((await precheckEmail("a@aonly.com")).status, "DOMAIN_VALID");
assert.equal((await precheckEmail("a@flaky.com")).status, "UNKNOWN", "DNS 临时故障不应判无效");
const role = await precheckEmail("Sales@good.com");
assert.equal(role.status, "DOMAIN_VALID");
assert.equal(role.isRole, true);

// 状态映射
assert.equal(mapProviderStatus("valid", false), "DELIVERABLE");
assert.equal(mapProviderStatus("invalid", false), "INVALID");
assert.equal(mapProviderStatus("catch-all", false), "CATCH_ALL");
assert.equal(mapProviderStatus("do_not_mail", false), "INVALID");
assert.equal(mapProviderStatus("whatever", false), "UNKNOWN");

// 默认策略：无记录放行；写入无效记录后拦截；有效放行
assert.equal(emailVerificationPolicy().requireVerified, false);
await assertEmailVerifiedForSend(team, "x@good.com");
await verifyEmail(team, "bad@missing.com");
await assert.rejects(() => assertEmailVerifiedForSend(team, "bad@missing.com"), /发信保护/);
await verifyEmail(team, "ok@good.com");
await assertEmailVerifiedForSend(team, "ok@good.com");
assert.equal(emailVerificationBlockReason("team_b", "bad@missing.com"), null, "按团队隔离");

// 缓存：未过期不重复查询
const before = mxCalls;
await verifyEmail(team, "ok@good.com");
assert.equal(mxCalls, before);
await verifyEmail(team, "ok@good.com", { force: true });
assert.equal(mxCalls, before + 1);

assert.equal(mapReoonStatus("safe"), "DELIVERABLE");
assert.equal(mapReoonStatus("disabled"), "INVALID");
assert.equal(mapReoonStatus("spamtrap"), "INVALID");
assert.equal(mapReoonStatus("catch_all"), "CATCH_ALL");
assert.equal(mapReoonStatus("role_account"), "ROLE");
assert.equal(mapReoonStatus("inbox_full"), "UNKNOWN");

// 第三方 API：Key 加密落库、视图不泄露、预筛失败不调 API
const raw = serializeEmailVerificationPolicy({
  enabled: true, provider: "zerobounce", apiKey: "secret-key-123", staleDays: 10,
  blockStatuses: ["INVALID", "DISPOSABLE", "CATCH_ALL"], requireVerified: true
});
assert.ok(!raw.includes("secret-key-123"));
setEmailVerificationPolicyRuntime(raw);
assert.equal(emailVerificationPolicy().apiKey, "secret-key-123");
assert.equal(JSON.stringify(emailVerificationPolicyView()).includes("secret-key-123"), false);
assert.equal(emailVerificationPolicyView().apiKeyConfigured, true);

apiBody = { status: "valid" };
assert.equal((await verifyEmail(team, "api1@good.com")).status, "DELIVERABLE");
assert.equal(apiCalls, 1);
await verifyEmail(team, "api2@missing.com");
assert.equal(apiCalls, 1, "预筛无效不应花钱调 API");
apiBody = { status: "catch-all" };
assert.equal((await verifyEmail(team, "api3@good.com")).status, "CATCH_ALL");
await assert.rejects(() => assertEmailVerifiedForSend(team, "api3@good.com"), /发信保护/);

// Reoon
setEmailVerificationPolicyRuntime(serializeEmailVerificationPolicy({
  enabled: true, provider: "reoon", apiKey: "reoon-key", staleDays: 10, blockStatuses: ["INVALID"], requireVerified: false
}));
apiBody = { status: "invalid", is_disposable: false, overall_score: 3 };
const reoonBad = await verifyEmail(team, "r1@good.com");
assert.equal(reoonBad.status, "INVALID");
assert.match(reoonBad.reason, /Reoon/);
apiBody = { status: "safe", overall_score: 98 };
assert.equal((await verifyEmail(team, "r2@good.com")).status, "DELIVERABLE");
setEmailVerificationPolicyRuntime(raw);

// 自动预筛：只做免费预筛，不调 API；手动验证再补调 API
assert.deepEqual(candidateEmailAddresses({ contactInfo: "Sales@Good.com, x", extractedContacts: [{ emails: ["a@good.com", "sales@good.com"] }] }), ["sales@good.com", "a@good.com"]);
apiBody = { status: "valid" };
const callsBefore = apiCalls;
await autoPrecheckEmails(team, ["pre1@good.com", "pre2@missing.com"]);
assert.equal(apiCalls, callsBefore, "自动预筛不应调用第三方 API");
assert.equal(getEmailVerification(team, "pre1@good.com")?.provider, "precheck");
assert.equal(getEmailVerification(team, "pre2@missing.com")?.status, "INVALID");
const manual = await verifyEmail(team, "pre1@good.com");
assert.equal(manual.status, "DELIVERABLE");
assert.equal(manual.provider, "zerobounce");
assert.equal(apiCalls, callsBefore + 1, "手动验证补调一次 API");
await verifyEmail(team, "pre1@good.com");
assert.equal(apiCalls, callsBefore + 1, "已用 API 验证过则走缓存");

// requireVerified：未验证邮箱发送时自动验证
apiBody = { status: "valid" };
assert.equal(getEmailVerification(team, "auto@good.com"), undefined);
await assertEmailVerifiedForSend(team, "auto@good.com");
assert.equal(getEmailVerification(team, "auto@good.com")?.status, "DELIVERABLE");

// 验证服务异常：requireVerified 下保守拒发
const failingFetch = (async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })) as unknown as typeof fetch;
setEmailVerifierDepsForTest({ fetch: failingFetch });
await assert.rejects(() => assertEmailVerifiedForSend(team, "down@good.com"), /验证服务暂不可用/);

// 关闭后一律放行
setEmailVerificationPolicyRuntime(JSON.stringify({ enabled: false }));
await assertEmailVerifiedForSend(team, "bad@missing.com");

resetEmailVerificationForTest();
console.log("Email verifier tests passed");
process.exit(0);
