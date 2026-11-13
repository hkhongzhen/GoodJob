import assert from "node:assert/strict";
import { entityDuplicateKey } from "./entity-duplicates.js";
import {
  applyLeadAssignment,
  assignableMembersFor,
  canAssignLead,
  canAssignLeads,
  leadAssignmentRows
} from "./lead-assignment.js";
import type { Lead, User } from "./types.js";

assert.equal(entityDuplicateKey("  ACME   Co ", " Germany"), entityDuplicateKey("acme co", "germany"));
assert.notEqual(entityDuplicateKey("acme", "de"), entityDuplicateKey("acme", "fr"));

const user = (id: string, role: User["role"], status: User["status"] = "active", teamId = "t1") =>
  ({ id, name: id, role, status, teamId }) as User;
const users = [
  user("boss", "manager"), user("s1", "sales"), user("s2", "sales"),
  user("off", "sales", "disabled"), user("other", "sales", "active", "t2"), user("root", "super_admin")
];
const lead = (patch: Partial<Lead> = {}) =>
  ({ id: "l1", company: "Acme", country: "DE", stage: "新线索", status: "new", ownerId: "boss", teamId: "t1", ...patch }) as Lead;

const boss = { id: "boss", role: "manager" as const, teamId: "t1" };
const s1 = { id: "s1", role: "sales" as const, teamId: "t1" };
const s1Iam = { ...s1, iamPermissions: { "lead.assign": ["self" as const] } };

assert.equal(canAssignLeads(boss), true);
assert.equal(canAssignLeads(s1), false);
assert.equal(canAssignLeads(s1Iam), true);

assert.equal(canAssignLead(boss, lead({ ownerId: "s2" })), true, "上级可指派团队任意线索");
assert.equal(canAssignLead({ ...boss, teamId: "t2" }, lead()), false, "不能跨团队");
assert.equal(canAssignLead(s1Iam, lead({ ownerId: "s1" })), true);
assert.equal(canAssignLead(s1Iam, lead({ ownerId: "s2", assignedBy: "s1" })), true, "可改派自己指派出去的线索");
assert.equal(canAssignLead(s1Iam, lead({ ownerId: "s2" })), false);

assert.deepEqual(assignableMembersFor(users, boss).map((m) => m.id), ["s1", "s2"]);

const target = lead();
assert.equal(applyLeadAssignment({ lead: target, toOwnerId: "boss", actorId: "boss", note: "", now: "n" }).changed, false);
assert.equal(target.assignedAt, undefined);
const changed = applyLeadAssignment({ lead: target, toOwnerId: "s1", actorId: "boss", note: "德国区", now: "2026-01-01T00:00:00.000Z" });
assert.equal(changed.changed, true);
assert.equal(target.ownerId, "s1");
assert.equal(target.assignmentFrom, "boss");
assert.equal(target.assignedBy, "boss");

const rows = leadAssignmentRows([target, lead({ id: "l2" })], users, boss);
assert.equal(rows.length, 1);
assert.deepEqual([rows[0].ownerName, rows[0].fromOwnerName, rows[0].assignedByName, rows[0].note], ["s1", "boss", "boss", "德国区"]);
assert.equal(leadAssignmentRows([target], users, { id: "s2", role: "sales", teamId: "t1" }).length, 0);

console.log("lead-assignment tests passed");
