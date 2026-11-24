import { buildProspectScorecard } from "./prospect-scorecard.js";
import { currentApprovedProspectDecision } from "./prospect-qualification-workflow.js";
import type { CrmStore } from "./store.js";
import { emailVerificationBlockReason, getEmailVerification, type EmailVerificationStatus } from "./email-verifier.js";
import type {
  Customer,
  Lead,
  ProspectContactChannelType,
  ProspectOutreachChannel,
  WebsiteOpportunity
} from "./types.js";

export type CrmOutreachEntity =
  | { entityType: "candidate"; entity: WebsiteOpportunity }
  | { entityType: "lead"; entity: Lead }
  | { entityType: "customer"; entity: Customer };

export type CrmOutreachEligibility = {
  mode: "prospect_managed" | "historical";
  channel: ProspectOutreachChannel;
  recipient: string;
  candidate?: WebsiteOpportunity;
};

export class ProspectOutreachEligibilityError extends Error {
  constructor(
    public readonly code:
      | "PROSPECT_OUTREACH_NOT_RESOLVED"
      | "PROSPECT_OUTREACH_NOT_OWNED"
      | "PROSPECT_OUTREACH_DO_NOT_CONTACT"
      | "PROSPECT_OUTREACH_NOT_ACTIVE"
      | "PROSPECT_OUTREACH_NOT_VQA"
      | "PROSPECT_OUTREACH_NOT_APPROVED"
      | "PROSPECT_OUTREACH_CHANNEL_MISMATCH"
      | "PROSPECT_OUTREACH_CHANNEL_UNSUPPORTED"
      | "PROSPECT_OUTREACH_RECIPIENT_MISSING",
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "ProspectOutreachEligibilityError";
  }
}

function fail(
  code: ProspectOutreachEligibilityError["code"],
  message: string,
  status = 409
): never {
  throw new ProspectOutreachEligibilityError(code, message, status);
}

function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizePhone(value: string) {
  return value.trim().replace(/[\s()-]/gu, "");
}

function normalizeRecipient(channel: ProspectOutreachChannel, value: string) {
  return channel === "email" ? normalizeEmail(value) : normalizePhone(value);
}

function formalChannelType(
  channel: ProspectOutreachChannel
): ProspectContactChannelType {
  return channel === "call" ? "phone" : channel;
}

function parsedProspectId(rawPayload: string) {
  try {
    const value = JSON.parse(rawPayload) as { prospectId?: unknown };
    return typeof value.prospectId === "string" ? value.prospectId : "";
  } catch {
    return "";
  }
}

function leadLineage(store: CrmStore, lead: Lead) {
  const sources = store.leadSourceEvents
    .filter((item) =>
      item.leadId === lead.id
      && item.teamId === lead.teamId
      && item.ownerId === lead.ownerId
      && item.channel === "prospect_conversion"
    )
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  const prospectIds = new Set(sources.flatMap((item) => [
    item.externalId,
    parsedProspectId(item.rawPayload)
  ]).filter(Boolean));
  const candidate = store.websiteOpportunities.find((item) =>
    item.teamId === lead.teamId
    && item.ownerId === lead.ownerId
    && (item.leadId === lead.id
      || Boolean(item.tenantProspectId && prospectIds.has(item.tenantProspectId)))
  );
  return { managed: sources.length > 0, candidate };
}

function customerLineage(store: CrmStore, customer: Customer) {
  const acquisitions = store.customerAcquisitionSourceEvents
    .filter((item) =>
      item.customerId === customer.id
      && item.teamId === customer.teamId
      && item.ownerId === customer.ownerId
      && item.prospectId
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const prospectIds = new Set(acquisitions.map((item) => item.prospectId));
  const candidate = store.websiteOpportunities.find((item) =>
    item.teamId === customer.teamId
    && item.ownerId === customer.ownerId
    && (item.customerId === customer.id
      || Boolean(item.tenantProspectId && prospectIds.has(item.tenantProspectId)))
  );
  return { managed: acquisitions.length > 0, candidate };
}

function candidateLineage(
  store: CrmStore,
  target: CrmOutreachEntity
): { managed: boolean; candidate?: WebsiteOpportunity } {
  if (target.entityType === "candidate") {
    return { managed: true, candidate: target.entity };
  }
  return target.entityType === "lead"
    ? leadLineage(store, target.entity)
    : customerLineage(store, target.entity);
}

function historicalRecipient(
  target: Exclude<CrmOutreachEntity, { entityType: "candidate" }>,
  channel: ProspectOutreachChannel
) {
  if (target.entityType === "lead") {
    return channel === "email" ? target.entity.email : target.entity.phone;
  }
  if (channel !== "email") return target.entity.whatsapp || "";
  return `${target.entity.documentContact || ""} ${target.entity.contact || ""}`
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] || "";
}

function assertOwnedAndUsable(
  target: CrmOutreachEntity,
  actorId: string
) {
  if (target.entity.ownerId !== actorId) {
    fail(
      "PROSPECT_OUTREACH_NOT_OWNED",
      "只有对象归属业务员可以发起真实外联",
      403
    );
  }
  if (target.entityType === "lead"
    && (target.entity.deletedAt || target.entity.status === "invalid")) {
    fail(
      "PROSPECT_OUTREACH_DO_NOT_CONTACT",
      "线索已删除或标记为无效，不能发起外联"
    );
  }
  if (target.entityType === "customer"
    && target.entity.poolStatus === "public") {
    fail(
      "PROSPECT_OUTREACH_NOT_OWNED",
      "公海客户必须先领取后才能发起外联",
      403
    );
  }
}

function assertManagedCandidateEligible(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  target: CrmOutreachEntity,
  channel: ProspectOutreachChannel,
  recipient: string,
  _at: string
): CrmOutreachEligibility {
  if (candidate.ownerId !== target.entity.ownerId
    || candidate.teamId !== target.entity.teamId) {
    fail(
      "PROSPECT_OUTREACH_NOT_RESOLVED",
      "搜客血缘与当前 CRM 对象归属不一致"
    );
  }
  // 2026-09-13 按需求移除客户资格审核链：不再要求企业身份归一、VQA 资格审核、
  // 人工可联系批准与通道一致性。仅保留用户显式设置的禁联 / 排除 / 抑制保护。
  const prospect = candidate.tenantProspectId
    ? store.tenantProspects.find((item) =>
        item.id === candidate.tenantProspectId
        && item.teamId === candidate.teamId
        && item.organizationId === candidate.organizationId)
    : undefined;
  if (prospect?.status === "do_not_contact") {
    fail(
      "PROSPECT_OUTREACH_DO_NOT_CONTACT",
      "该企业已进入永久禁止联系名单"
    );
  }
  if (candidate.status === "synced") {
    fail(
      "PROSPECT_OUTREACH_NOT_ACTIVE",
      "候选已转为线索，请通过线索或客户发起外联"
    );
  }
  if (candidate.status === "excluded"
    || candidate.outreachState === "suppressed"
    || (prospect
      && (prospect.exclusionMode !== "none"
        || prospect.queueState === "suppressed"))) {
    fail(
      "PROSPECT_OUTREACH_NOT_ACTIVE",
      "搜客对象当前处于排除、抑制或不可联系状态"
    );
  }
  return {
    mode: "prospect_managed",
    channel,
    recipient,
    candidate
  };
}

export function assertCrmOutreachEligible(
  store: CrmStore,
  input: {
    target: CrmOutreachEntity;
    actorId: string;
    channel: ProspectOutreachChannel;
    recipient: string;
    at?: string;
  }
): CrmOutreachEligibility {
  assertOwnedAndUsable(input.target, input.actorId);
  const recipient = input.recipient.trim();
  if (!recipient) {
    fail(
      "PROSPECT_OUTREACH_RECIPIENT_MISSING",
      "外联目标不能为空",
      400
    );
  }
  const lineage = candidateLineage(store, input.target);
  if (lineage.managed) {
    if (!lineage.candidate) {
      fail(
        "PROSPECT_OUTREACH_NOT_RESOLVED",
        "CRM 对象带有搜客血缘，但对应候选资格记录不存在"
      );
    }
    return assertManagedCandidateEligible(
      store,
      lineage.candidate,
      input.target,
      input.channel,
      recipient,
      input.at || new Date().toISOString()
    );
  }
  if (input.target.entityType === "candidate") {
    fail(
      "PROSPECT_OUTREACH_NOT_RESOLVED",
      "候选搜客对象缺少正式血缘"
    );
  }
  const expected = historicalRecipient(input.target, input.channel);
  if (!expected) {
    fail(
      "PROSPECT_OUTREACH_RECIPIENT_MISSING",
      "历史 CRM 对象没有可用的已保存联系方式",
      400
    );
  }
  if (normalizeRecipient(input.channel, recipient)
    !== normalizeRecipient(input.channel, expected)) {
    fail(
      "PROSPECT_OUTREACH_CHANNEL_MISMATCH",
      "实际收件目标必须与 CRM 中已保存的联系方式一致",
      400
    );
  }
  return {
    mode: "historical",
    channel: input.channel,
    recipient: expected
  };
}

export function assertProspectEmailOutreachEligible(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  recipient: string,
  at = new Date().toISOString()
) {
  const result = assertCrmOutreachEligible(store, {
    target: { entityType: "candidate", entity: candidate },
    actorId: candidate.ownerId,
    channel: "email",
    recipient,
    at
  });
  // 资格审核链移除后，正式身份与人工批准记录可能不存在，返回可空值。
  const prospect = candidate.tenantProspectId
    ? store.tenantProspects.find((item) =>
        item.id === candidate.tenantProspectId
        && item.teamId === candidate.teamId) ?? null
    : null;
  const approved = currentApprovedProspectDecision(store, candidate, at);
  return {
    prospect,
    scorecard: buildProspectScorecard(store, candidate, at),
    decision: approved?.decision ?? null,
    channel: approved?.channel ?? null,
    recipient: result.recipient
  };
}

export type ProspectEmailOutreachState = "ready" | "missing_email" | "blocked" | "bounced" | "invalid_email";

export interface ProspectEmailOutreachEligibility {
  ready: boolean;
  state: ProspectEmailOutreachState;
  /** 展示用短标签：可发信 / 缺邮箱 / 已抑制 / 邮箱退信 */
  label: string;
  code: string;
  message: string;
  recipient: string;
  /** 因已退信而被跳过的邮箱；非空表示当前收件人是备用邮箱（灯仍可发，但界面应提示） */
  skippedBounced?: string[];
  /** 收件人的邮箱验证结果；未验证时为空 */
  verification?: { status: EmailVerificationStatus; reason: string; checkedAt: string };
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const EMAIL_STATE_LABELS: Record<ProspectEmailOutreachState, string> = {
  ready: "可发信",
  missing_email: "缺邮箱",
  blocked: "已抑制",
  bounced: "邮箱退信",
  invalid_email: "邮箱未通过验证"
};
const READY_FALLBACK_LABEL = "可发信·备用邮箱";

function allEmails(...values: Array<string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  const pattern = new RegExp(EMAIL_PATTERN.source, "giu");
  for (const value of values) {
    for (const match of String(value || "").matchAll(pattern)) {
      const email = match[0].trim();
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(email);
    }
  }
  return result;
}

/** 该团队已发生退信的收件地址（小写）。退信记录来自收件同步写入的发信台账 bouncedAt。 */
function bouncedRecipients(store: CrmStore, teamId: string) {
  const bounced = new Set<string>();
  for (const log of store.outboundEmailLogs || []) {
    if (!log.bouncedAt || log.teamId !== teamId) continue;
    for (const email of allEmails(log.to)) bounced.add(email.toLowerCase());
  }
  return bounced;
}

/**
 * 候选名单的"发信资格灯"。
 *
 * 复用 assertProspectEmailOutreachEligible 的同一套判定分支，但把「抛错」改成三态返回值
 * （可发信 / 缺邮箱 / 已抑制），并附带原始错误码与原因，供列表批量渲染 —— 不产生任何副作用，
 * 也绝不因为某个候选不可发信而让整个清单接口失败。
 *
 * @param recipientOverride 当调用方已知目标邮箱（如用户手动填入）时传入；
 *   缺省时按「人工批准通道值 → 最近一次发信 → contactInfo → contact → 官网抽取邮箱」依次取第一个。
 */
export function evaluateProspectEmailOutreachEligibility(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  at = new Date().toISOString(),
  recipientOverride = ""
): ProspectEmailOutreachEligibility {
  const result = evaluateEligibilityCore(store, candidate, at, recipientOverride);
  const record = result.recipient ? getEmailVerification(candidate.teamId, result.recipient) : undefined;
  return record
    ? { ...result, verification: { status: record.status, reason: record.reason, checkedAt: record.checkedAt } }
    : result;
}

function evaluateEligibilityCore(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  at = new Date().toISOString(),
  recipientOverride = ""
): ProspectEmailOutreachEligibility {
  const approved = currentApprovedProspectDecision(store, candidate, at);
  const approvedEmail = approved && approved.channel.channelType === formalChannelType("email")
    ? approved.channel.value
    : "";
  const extracted = (candidate.extractedContacts || [])
    .map((item) => (item.emails || []).join(" "))
    .join(" ");
  // 调用方显式给了收件地址时只判定它本身；否则候选的邮箱按优先级排序，
  // 已退信的地址会被跳过，改用下一个可用地址（换邮箱应当可以继续发）。
  const overrideEmails = allEmails(recipientOverride);
  const emails = overrideEmails.length
    ? overrideEmails.slice(0, 1)
    : allEmails(
        approvedEmail,
        candidate.lastDevelopmentEmailTo,
        candidate.contactInfo,
        candidate.contact,
        extracted
      );
  if (!emails.length) {
    return {
      ready: false,
      state: "missing_email",
      label: EMAIL_STATE_LABELS.missing_email,
      code: "PROSPECT_OUTREACH_RECIPIENT_MISSING",
      message: "该候选还没有可用邮箱，先补全联系方式",
      recipient: ""
    };
  }
  const bounced = bouncedRecipients(store, candidate.teamId);
  const unverified = (email: string) => emailVerificationBlockReason(candidate.teamId, email);
  const recipient = emails.find((email) => !bounced.has(email.toLowerCase()) && !unverified(email)) || "";
  if (!recipient) {
    const rejected = emails.filter((email) => !bounced.has(email.toLowerCase()));
    if (rejected.length) {
      return {
        ready: false,
        state: "invalid_email",
        label: EMAIL_STATE_LABELS.invalid_email,
        code: "PROSPECT_OUTREACH_RECIPIENT_UNVERIFIED",
        message: `邮箱验证未通过：${rejected.map((email) => `${email}（${unverified(email)}）`).join("、")}，请补充其他有效邮箱`,
        recipient: ""
      };
    }
    return {
      ready: false,
      state: "bounced",
      label: EMAIL_STATE_LABELS.bounced,
      code: "PROSPECT_OUTREACH_RECIPIENT_BOUNCED",
      message: `该邮箱已退信（${emails.join("、")}），请补充其他有效邮箱后再发`,
      recipient: ""
    };
  }
  try {
    const result = assertProspectEmailOutreachEligible(store, candidate, recipient, at);
    const skippedBounced = emails.filter((email) => bounced.has(email.toLowerCase()) || unverified(email));
    if (skippedBounced.length) {
      return {
        ready: true,
        state: "ready",
        label: READY_FALLBACK_LABEL,
        code: "READY_FALLBACK_RECIPIENT",
        message: `${skippedBounced.join("、")} 已退信，将改发备用邮箱 ${result.recipient}`,
        recipient: result.recipient,
        skippedBounced
      };
    }
    return {
      ready: true,
      state: "ready",
      label: EMAIL_STATE_LABELS.ready,
      code: "READY",
      message: "可直接发信",
      recipient: result.recipient
    };
  } catch (error) {
    if (error instanceof ProspectOutreachEligibilityError) {
      return {
        ready: false,
        state: "blocked",
        label: EMAIL_STATE_LABELS.blocked,
        code: error.code,
        message: error.message,
        recipient: ""
      };
    }
    throw error;
  }
}
