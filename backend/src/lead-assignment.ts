/**
 * 线索指派：权限判定、可指派成员、指派落库字段、指派一览表。
 *
 * 本文件由调用方（routes/leads.ts、frontend/src/modules/leads.ts）反推补全：
 * - 权限码为 IAM 的 `lead.assign`；
 * - 「上级」= legacy admin/manager，或 IAM 授权范围不止 self，可指派本团队任意可见线索；
 * - 其余被授予 `lead.assign` 的账号只能指派进入自己账号的线索，或改派自己指派出去的线索；
 * - 接收人须为本团队在职、非平台管理员的员工；
 * - 只保留最近一次指派（assignedBy / assignedAt / assignmentFrom / assignmentNote），
 *   完整历史由路由层写入 leadActivities。
 */
import { hasIamPermission, type IamActor } from "./auth.js";
import type { Lead, SessionUser, User } from "./types.js";


export interface AssignableMember {
  id: string;
  name: string;
  role: string;
}

export interface LeadAssignmentRow {
  leadId: string;
  company: string;
  country: string;
  stage: string;
  status: string;
  ownerId: string;
  ownerName: string;
  fromOwnerName: string;
  assignedByName: string;
  assignedAt: string;
  note: string;
}

/** 当前账号是否拥有「指派线索」能力。 */
export function canAssignLeads(user: IamActor | undefined) {
  return hasIamPermission(user, "lead.assign");
}

/** 上级口径：legacy admin/manager，或 IAM 的 lead.assign 范围不只是 self。 */
export function isSupervisorAssigner(user: IamActor | undefined) {
  if (!user || !canAssignLeads(user)) return false;
  const scopes = user.iamPermissions?.["lead.assign"];
  if (scopes?.length) return scopes.some((scope) => scope !== "self");
  return user.role === "admin" || user.role === "manager";
}

/** 能否指派/改派这条具体线索。 */
export function canAssignLead(user: IamActor, lead: Pick<Lead, "ownerId" | "teamId" | "assignedBy">) {
  if (!canAssignLeads(user)) return false;
  if (lead.teamId !== user.teamId) return false;
  if (isSupervisorAssigner(user)) return true;
  return lead.ownerId === user.id || lead.assignedBy === user.id;
}

/** 可作为接收人的员工（本团队在职、非平台管理员，不含操作者本人——前端另有「收回名下」选项）。 */
export function assignableMembersFor(users: User[], actor: IamActor): AssignableMember[] {
  return users
    .filter((item) =>
      item.teamId === actor.teamId
      && item.status === "active"
      && item.role !== "super_admin"
      && item.id !== actor.id
    )
    .map((item) => ({ id: item.id, name: item.name, role: item.role }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/**
 * 把指派写到线索上。负责人未变化时不改任何字段并返回 changed=false。
 * 调用方负责权限、接收人校验与持久化。
 */
export function applyLeadAssignment(input: {
  lead: Lead;
  toOwnerId: string;
  actorId: string;
  note: string;
  now: string;
}) {
  const { lead, toOwnerId, actorId, note, now } = input;
  if (lead.ownerId === toOwnerId) return { changed: false as const, fromOwnerId: lead.ownerId };
  const fromOwnerId = lead.ownerId;
  lead.ownerId = toOwnerId;
  lead.assignedBy = actorId;
  lead.assignedAt = now;
  lead.assignmentFrom = fromOwnerId;
  lead.assignmentNote = note;
  lead.lastActivityAt = now;
  return { changed: true as const, fromOwnerId };
}

/** 指派一览表：上级看本团队全部，其余只看与自己相关（名下或自己指派的）。按指派时间倒序。 */
export function leadAssignmentRows(leads: Lead[], users: User[], actor: IamActor): LeadAssignmentRow[] {
  const nameOf = (id: string | undefined) => (id ? users.find((item) => item.id === id)?.name || "" : "");
  const supervisor = isSupervisorAssigner(actor);
  return leads
    .filter((lead) =>
      Boolean(lead.assignedAt)
      && !lead.deletedAt
      && lead.teamId === actor.teamId
      && (supervisor || lead.ownerId === actor.id || lead.assignedBy === actor.id)
    )
    .map((lead) => ({
      leadId: lead.id,
      company: lead.company,
      country: lead.country,
      stage: lead.stage,
      status: lead.status,
      ownerId: lead.ownerId,
      ownerName: nameOf(lead.ownerId) || "未分配",
      fromOwnerName: nameOf(lead.assignmentFrom) || "未分配",
      assignedByName: nameOf(lead.assignedBy) || "—",
      assignedAt: lead.assignedAt || "",
      note: lead.assignmentNote || ""
    }))
    .sort((a, b) => (a.assignedAt < b.assignedAt ? 1 : -1));
}
