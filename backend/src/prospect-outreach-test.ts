import assert from "node:assert/strict";
import {
  migrateProspectFollowUpTodos,
  recordProspectTouchpoint
} from "./prospect-outreach.js";
import { evaluateProspectEmailOutreachEligibility } from "./prospect-outreach-eligibility.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type { WebsiteOpportunity } from "./types.js";

const at = (day: number, hour = 9) =>
  new Date(Date.UTC(2026, 6, day, hour)).toISOString();

function localDueText(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isolatedStore(): CrmStore {
  const base = getStore();
  return {
    ...base,
    mode: "memory",
    websiteOpportunities: [],
    prospectTouchpoints: [],
    todos: [],
    leads: [],
    customers: [],
    deals: [],
    prospectContactChannels: [],
    prospectContactVerificationSnapshots: [],
    prospectSuppressionEvents: [],
    prospectContactabilityDecisions: [],
    outboundEmailLogs: [],
    applyProspectQualification: undefined,
    async persist() {
      // Isolated in-memory contract test.
    },
    async readBarrier() {
      // The test executes synchronously.
    }
  };
}

function candidate(
  suffix: string,
  ownerId = "sales-owner",
  teamId = "team-a"
): WebsiteOpportunity {
  return {
    id: `candidate-${suffix}`,
    company: `Prospect ${suffix} GmbH`,
    business: "Industrial components",
    country: "DE",
    website: `https://${suffix}.example.test`,
    contact: "Purchasing",
    contactInfo: `buyer@${suffix}.example.test`,
    description: "Outreach contract test",
    ownerId,
    teamId,
    status: "contactable",
    createdAt: at(1),
    outreachState: "uncontacted"
  };
}

async function testOutboundIdempotencyAndTodoReuse() {
  const store = isolatedStore();
  const prospect = candidate("idempotency");
  store.websiteOpportunities.push(prospect);
  const protectedCounts = {
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length
  };

  const first = await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "email",
    direction: "outbound",
    contactValue: prospect.contactInfo,
    subject: "Product introduction",
    content: "A structured development email.",
    requestId: "outbound-idempotency-1",
    occurredAt: at(15)
  });

  assert.equal(first.replayed, false);
  assert.equal(store.prospectTouchpoints.length, 1);
  assert.equal(store.todos.length, 1);
  assert.equal(first.todo?.prospectCandidateId, prospect.id);
  assert.equal(first.todo?.outreachChannel, "email");
  assert.equal(prospect.status, "contacted");
  assert.equal(prospect.outreachState, "awaiting_reply");

  const replay = await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "email",
    direction: "outbound",
    contactValue: prospect.contactInfo,
    requestId: "outbound-idempotency-1",
    occurredAt: at(16)
  });

  assert.equal(replay.replayed, true);
  assert.equal(replay.touchpoint.id, first.touchpoint.id);
  assert.equal(replay.todo?.id, first.todo?.id);
  assert.equal(store.prospectTouchpoints.length, 1);
  assert.equal(store.todos.length, 1);
  assert.deepEqual({
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length
  }, protectedCounts);
}

async function testReplyReschedulesExistingTodo() {
  const store = isolatedStore();
  const prospect = candidate("reply");
  store.websiteOpportunities.push(prospect);
  const outbound = await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "email",
    direction: "outbound",
    contactValue: prospect.contactInfo,
    requestId: "reply-outbound-1",
    occurredAt: at(15)
  });
  const originalTodoId = outbound.todo?.id;

  const reply = await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "email",
    direction: "inbound",
    contactValue: prospect.contactInfo,
    content: "Please send the quotation this week.",
    replyClassification: "clear_demand",
    requestId: "reply-inbound-1",
    occurredAt: at(16, 11)
  });

  assert.equal(store.prospectTouchpoints.length, 2);
  assert.equal(store.todos.length, 1);
  assert.equal(reply.todo?.id, originalTodoId);
  assert.equal(reply.todo?.priority, "high");
  assert.equal(reply.todo?.dueAt, localDueText(at(16, 11)));
  assert.equal(reply.todo?.touchpointId, reply.touchpoint.id);
  assert.equal(prospect.lastReplyClassification, "clear_demand");
  assert.equal(prospect.outreachState, "replied");
}

async function testSuppressionCancelsActiveTodo() {
  for (const classification of ["rejected", "unsubscribed"] as const) {
    const store = isolatedStore();
    const prospect = candidate(classification);
    store.websiteOpportunities.push(prospect);
    await recordProspectTouchpoint(store, {
      candidate: prospect,
      actorId: prospect.ownerId,
      channel: "whatsapp",
      direction: "outbound",
      contactValue: "+49 170 123456",
      requestId: `${classification}-outbound`,
      occurredAt: at(15)
    });

    const reply = await recordProspectTouchpoint(store, {
      candidate: prospect,
      actorId: prospect.ownerId,
      channel: "whatsapp",
      direction: "inbound",
      contactValue: "+49 170 123456",
      replyClassification: classification,
      requestId: `${classification}-reply`,
      occurredAt: at(16)
    });

    assert.equal(reply.cancelled?.length, 1);
    assert.equal(store.todos.length, 1);
    assert.equal(store.todos[0]?.done, true);
    assert.ok(store.todos[0]?.cancelledAt);
    assert.equal(prospect.status, "excluded");
    assert.equal(prospect.outreachState, "suppressed");
    assert.equal(prospect.nextFollowAt, "");
  }
}

async function testBounceMarksChannelInvalid() {
  const store = isolatedStore();
  const prospect = candidate("bounce");
  store.websiteOpportunities.push(prospect);
  await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "email",
    direction: "outbound",
    contactValue: prospect.contactInfo,
    requestId: "bounce-outbound",
    occurredAt: at(15)
  });

  await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "email",
    direction: "inbound",
    contactValue: prospect.contactInfo,
    replyClassification: "bounced",
    requestId: "bounce-reply",
    occurredAt: at(16)
  });

  assert.deepEqual(prospect.invalidContactChannels, ["email"]);
  assert.equal(prospect.status, "preview");
  assert.equal(prospect.outreachState, "contact_invalid");
  assert.equal(store.todos[0]?.done, true);
  assert.equal(
    store.todos[0]?.cancellationReason,
    "联系方式退信，待补充有效联系方式"
  );
}

async function testLeadMigrationReusesOutreachData() {
  const store = isolatedStore();
  const prospect = candidate("migration");
  store.websiteOpportunities.push(prospect);
  await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    channel: "call",
    direction: "outbound",
    contactValue: "+49 30 123456",
    requestId: "migration-outbound",
    occurredAt: at(15)
  });
  const todoId = store.todos[0]?.id;
  const touchpointId = store.prospectTouchpoints[0]?.id;

  migrateProspectFollowUpTodos(store, prospect, "lead-migration-1");

  assert.equal(prospect.leadId, "lead-migration-1");
  assert.equal(store.todos.length, 1);
  assert.equal(store.todos[0]?.id, todoId);
  assert.equal(store.todos[0]?.leadId, "lead-migration-1");
  assert.match(store.todos[0]?.title || "", /^跟进线索：/u);
  assert.equal(store.prospectTouchpoints.length, 1);
  assert.equal(store.prospectTouchpoints[0]?.id, touchpointId);
  assert.equal(
    store.prospectTouchpoints[0]?.leadId,
    "lead-migration-1"
  );
  assert.equal(store.customers.length, 0);
  assert.equal(store.deals.length, 0);
}

async function testOwnerIsolation() {
  const store = isolatedStore();
  const prospect = candidate("owner");
  store.websiteOpportunities.push(prospect);

  await assert.rejects(
    recordProspectTouchpoint(store, {
      candidate: prospect,
      actorId: "manager-from-same-team",
      channel: "email",
      direction: "outbound",
      requestId: "owner-isolation",
      occurredAt: at(15)
    }),
    /只有候选归属业务员可以记录触达/u
  );
  assert.equal(store.prospectTouchpoints.length, 0);
  assert.equal(store.todos.length, 0);
}

async function testHistoricalOutboundIsFactOnly() {
  const store = isolatedStore();
  const prospect = candidate("historical");
  store.websiteOpportunities.push(prospect);
  const before = structuredClone(prospect);

  const result = await recordProspectTouchpoint(store, {
    candidate: prospect,
    actorId: prospect.ownerId,
    recordMode: "historical",
    channel: "email",
    direction: "outbound",
    contactValue: prospect.contactInfo,
    subject: "Previously sent message",
    content: "This message was sent outside the CRM yesterday.",
    requestId: "historical-fact-only",
    occurredAt: at(14)
  });

  assert.equal(result.replayed, false);
  assert.equal(store.prospectTouchpoints.length, 1);
  assert.equal(store.todos.length, 0);
  assert.equal(result.todo, undefined);
  assert.deepEqual(prospect, before);
}

function bouncedLog(to: string, teamId = "team-a") {
  return {
    id: `oel-${to}`,
    teamId,
    ownerId: "sales-owner",
    messageId: `gj-${to}`,
    entityType: "candidate" as const,
    entityId: "x",
    to,
    subject: "hi",
    source: "manual",
    sentAt: at(2),
    bouncedAt: at(2, 10),
    createdAt: at(2)
  };
}

async function testBouncedAddressTurnsEligibilityLightOff() {
  const store = isolatedStore();
  store.outboundEmailLogs = [];
  const prospect = candidate("bounce-light");
  store.websiteOpportunities.push(prospect);

  assert.equal(evaluateProspectEmailOutreachEligibility(store, prospect).state, "ready");

  // 退信后：唯一邮箱已退信 → 第四态，不再显示可发信，也不能进批量发送。
  store.outboundEmailLogs.push(bouncedLog(prospect.contactInfo.toUpperCase()));
  const bounced = evaluateProspectEmailOutreachEligibility(store, prospect);
  assert.equal(bounced.ready, false);
  assert.equal(bounced.state, "bounced");
  assert.equal(bounced.label, "邮箱退信");
  assert.equal(bounced.code, "PROSPECT_OUTREACH_RECIPIENT_BOUNCED");
  assert.equal(bounced.recipient, "");

  // 候选还有其他邮箱 → 跳过已退信的，改用下一个，仍可发信。
  prospect.extractedContacts = [{ emails: ["info@bounce-light.example.test"] }] as WebsiteOpportunity["extractedContacts"];
  const fallback = evaluateProspectEmailOutreachEligibility(store, prospect);
  assert.equal(fallback.state, "ready");
  assert.equal(fallback.recipient, "info@bounce-light.example.test");
  assert.equal(fallback.label, "可发信·备用邮箱");
  assert.deepEqual(fallback.skippedBounced, [prospect.contactInfo]);

  // 其他团队的退信不影响本团队。
  const other = isolatedStore();
  other.outboundEmailLogs = [bouncedLog(prospect.contactInfo, "team-b")];
  const unaffected = candidate("bounce-light");
  assert.equal(evaluateProspectEmailOutreachEligibility(other, unaffected).state, "ready");

  // 显式指定收件地址时只判定该地址：已退信的地址即使有备用邮箱也不放行。
  const explicit = evaluateProspectEmailOutreachEligibility(store, prospect, undefined, prospect.contactInfo);
  assert.equal(explicit.state, "bounced");
}

await testOutboundIdempotencyAndTodoReuse();
await testReplyReschedulesExistingTodo();
await testSuppressionCancelsActiveTodo();
await testBounceMarksChannelInvalid();
await testLeadMigrationReusesOutreachData();
await testOwnerIsolation();
await testHistoricalOutboundIsFactOnly();
await testBouncedAddressTurnsEligibilityLightOff();

console.log("Prospect outreach tests passed");
