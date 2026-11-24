/**
 * 个人资料、已读追踪、发件邮箱池、开发信预览。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, confirmAction, openModal, state } from "../prototype-api";
import { type User } from "./models";

import { badge, escapeHtml, qs, qsa, roleLabel, setFieldValue, storage } from "./shared";
import { loadCompanyProfile, renderEmailConfigurationReminders } from "./development-email";
import { api, setButtonPending, toast } from "./ui";
import { loadEmailVerificationConfig } from "./email-verification";
import { applyAuthedUser, roleScopeText, updateProfileSmtpHints } from "./auth";

export function renderProfile(user = state.user) {
  if (!user) return;
  const avatar = qs<HTMLElement>("#profileAvatarLarge");
  const name = qs<HTMLElement>("#profileNameTitle");
  const role = qs<HTMLElement>("#profileRoleText");
  const status = qs<HTMLElement>("#profileEmailStatus");
  const signatureStatus = qs<HTMLElement>("#profileSignatureStatus");
  const defaultMailboxEl = qs<HTMLElement>("#profileDefaultMailbox");
  const teamText = user.teamId === "all" ? "全局团队" : `${user.teamId} 组`;
  const mailReady = Boolean(user.outboundEmail);
  if (avatar) avatar.textContent = user.avatar;
  if (name) name.textContent = user.name;
  const effectiveRoleName = state.iamCapabilities?.roleNames.join(" / ") || user.iamRoleNames?.join(" / ") || roleLabel[user.role];
  if (role) role.textContent = `${effectiveRoleName} · ${roleScopeText(user)}`;
  qs<HTMLElement>("#profileStatusBadge")!.textContent = "账号正常";
  qs<HTMLElement>("#profileTeamBadge")!.textContent = teamText;
  const emailBadge = qs<HTMLElement>("#profileEmailBadge");
  if (emailBadge) {
    emailBadge.className = `badge ${mailReady ? "green" : "amber"}`;
    emailBadge.textContent = mailReady ? "发件邮箱已绑定" : "发件邮箱待绑定";
  }
  const allScopes = Object.values(state.iamCapabilities?.permissions || user.iamPermissions || {}).flat();
  qs<HTMLElement>("#profileScopeMetric")!.textContent = user.iamSource === "platform" || state.iamCapabilities?.source === "platform"
    ? "平台运维"
    : allScopes.includes("tenant") ? "公司范围" : allScopes.includes("org_subtree") || allScopes.includes("org_unit") ? "组织范围" : "本人业务";
  qs<HTMLElement>("#profileRoleMetric")!.textContent = effectiveRoleName;
  qs<HTMLElement>("#profileMailMetric")!.textContent = mailReady && user.smtpHost && user.hasSmtpPassword ? "可真实发信" : mailReady ? "待配SMTP" : "未绑定";
  qs<HTMLElement>("#profileLoginEmailText")!.textContent = user.email;
  qs<HTMLElement>("#profileIdText")!.textContent = user.id;
  qs<HTMLElement>("#profileScopeText")!.textContent = roleScopeText(user);
  setFieldValue("#profileLoginEmail", user.email);
  setFieldValue("#profileEmailSignature", user.emailSignature || "");
  setFieldValue("#profileTestEmailTo", "");
  if (status) status.innerHTML = user.outboundEmail ? `${badge("已设置", "green")} ${escapeHtml(user.outboundEmail)}` : `${badge("未设置", "amber")} 在下方把某个邮箱「设为默认」`;
  if (signatureStatus) signatureStatus.innerHTML = user.emailSignature?.trim() ? `${badge("已设置", "green")} ${escapeHtml((user.emailSignature.split("\n")[0] || "签名已维护").slice(0, 36))}` : badge("待完善", "amber");
  const smtpStatus = qs<HTMLElement>("#profileSmtpStatus");
  if (smtpStatus) smtpStatus.innerHTML = user.smtpHost && user.smtpUser && user.hasSmtpPassword ? `${badge("已配置", "green")} ${escapeHtml(user.smtpHost)}` : `${badge("未完整", "amber")} 默认邮箱补全 SMTP 后才能真实发信`;
  const defaultMailbox = senderMailboxes.find((item) => item.isDefault)
    || senderMailboxes.find((item) => item.email.toLowerCase() === (user.outboundEmail || "").toLowerCase());
  if (defaultMailboxEl) {
    defaultMailboxEl.innerHTML = defaultMailbox
      ? `${badge("默认", "green")} ${escapeHtml(defaultMailbox.label || defaultMailbox.email)} <small>${escapeHtml(defaultMailbox.email)} · ${escapeHtml(defaultMailbox.smtpHost)}:${defaultMailbox.smtpPort} · ${escapeHtml(defaultMailbox.imapHost || "IMAP 自动推导")}</small>`
      : user.outboundEmail
        ? `${badge("默认", "green")} ${escapeHtml(user.outboundEmail)} <small>该地址不在下方账号列表中——把它登记进来才能集中管理收信</small>`
        : `尚未设置默认邮箱——先在下方添加邮箱，再设为默认`;
  }
  updateProfileSmtpHints(user);
  renderEmailConfigurationReminders();
  void loadCompanyProfile();
  void loadSenderMailboxes();
  void loadEmailTrackingConfig();
  void loadBounceGuardConfig();
  void loadEmailVerificationConfig();
}

// ---------------------------------------------------------------------------
// 发件邮箱池：登记多个 SMTP 发件邮箱，自动发信方案按「每 N 封」轮换使用
// ---------------------------------------------------------------------------

export interface SenderMailboxView {
  id: string;
  label: string;
  email: string;
  fromName: string;
  /** 该邮箱专属署名尾缀；空 = 沿用账号级邮件签名 */
  signature?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  enabled: boolean;
  hasSmtpPassword: boolean;
  hasImapPassword: boolean;
  dkimDomain?: string;
  dkimSelector?: string;
  hasDkimPrivateKey?: boolean;
  dailyLimit?: number;
  /** 是否账号默认发件身份（后端按 email == users.outbound_email 判定） */
  isDefault?: boolean;
  syncEnabled?: boolean;
  syncIntervalMinutes?: number;
}

// ── 已读追踪配置（个人设置 → 已读追踪）─────────────────────────────
interface EmailTrackingConfigView {
  enabled: boolean;
  baseUrl: string;
  source: string;
  messageIdDomain: string;
  secretConfigured: boolean;
}

export async function loadEmailTrackingConfig() {
  const box = qs<HTMLElement>("#trackingConfigStatus");
  if (!box) return;
  try {
    const { config } = await api<{ config: EmailTrackingConfigView }>("/api/email-tracking/config");
    const input = qs<HTMLInputElement>("#trackingBaseUrlInput");
    if (input && document.activeElement !== input) input.value = config.baseUrl;
    box.innerHTML = config.enabled
      ? `<span class="badge green">已开启</span> <small>信号回传域名 <b>${escapeHtml(config.messageIdDomain)}</b> · 来源 ${config.source === "app_settings" ? "本页配置" : "环境变量"}</small>`
      : `<span class="badge gray">未开启</span> <small>发出的开发信不含追踪像素，无法得知客户是否打开</small>`;
  } catch (error) {
    box.innerHTML = `<span class="badge amber">读取失败</span> <small>${escapeHtml(error instanceof Error ? error.message : "未知错误")}</small>`;
  }
}

export async function saveEmailTrackingConfig(button?: HTMLButtonElement | null) {
  const input = qs<HTMLInputElement>("#trackingBaseUrlInput");
  if (!input) return;
  const baseUrl = input.value.trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    toast("地址必须以 http:// 或 https:// 开头", "error");
    return;
  }
  setButtonPending(button ?? null, true, "保存", "保存中");
  try {
    const { config } = await api<{ config: EmailTrackingConfigView }>("/api/email-tracking/config", { method: "PUT", body: JSON.stringify({ baseUrl }) });
    toast(config.enabled ? "已读追踪已开启：之后发出的开发信会带回打开/点击信号" : "已读追踪已关闭：信件按纯文本发送");
    await loadEmailTrackingConfig();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存已读追踪配置失败", "error");
  } finally {
    setButtonPending(button ?? null, false, "保存", "保存中");
  }
}

// ── 退信保护（邮箱设置 → 退信保护）─────────────────────────────────────
interface BounceGuardView {
  config: { enabled: boolean; maxBouncePercent: number; windowDays: number; minSample: number; source: string };
  stats: { sent: number; bounced: number; percent: number; triggered: boolean };
}

function renderBounceGuard(view: BounceGuardView) {
  const { config, stats } = view;
  const enabled = qs<HTMLInputElement>("#bounceGuardEnabled");
  if (enabled) enabled.checked = config.enabled;
  setFieldValue("#bounceGuardPercent", String(config.maxBouncePercent));
  setFieldValue("#bounceGuardWindow", String(config.windowDays));
  setFieldValue("#bounceGuardMinSample", String(config.minSample));
  const box = qs<HTMLElement>("#bounceGuardStatus");
  if (!box) return;
  const figures = `近 ${config.windowDays} 天发出 <b>${stats.sent}</b> 封，退信 <b>${stats.bounced}</b> 封，退信率 <b>${stats.percent}%</b>`;
  const state = !config.enabled
    ? badge("已关闭", "gray")
    : stats.triggered
      ? badge("已触发 · 外发暂停中", "amber")
      : stats.sent < config.minSample
        ? badge(`样本不足 ${config.minSample} 封 · 不判定`, "green")
        : badge("正常", "green");
  box.innerHTML = `${state} <small>${figures}</small>`;
}

export async function loadBounceGuardConfig() {
  const box = qs<HTMLElement>("#bounceGuardStatus");
  if (!box) return;
  try {
    renderBounceGuard(await api<BounceGuardView>("/api/email-delivery/bounce-guard"));
  } catch (error) {
    box.innerHTML = `${badge("读取失败", "amber")} <small>${escapeHtml(error instanceof Error ? error.message : "未知错误")}</small>`;
  }
}

export async function saveBounceGuardConfig(button?: HTMLButtonElement | null) {
  const enabled = qs<HTMLInputElement>("#bounceGuardEnabled")?.checked ?? true;
  const maxBouncePercent = Math.round(Number(qs<HTMLInputElement>("#bounceGuardPercent")?.value || 10));
  const windowDays = Math.round(Number(qs<HTMLInputElement>("#bounceGuardWindow")?.value || 7));
  const minSample = Math.round(Number(qs<HTMLInputElement>("#bounceGuardMinSample")?.value || 20));
  if (!(maxBouncePercent >= 1 && maxBouncePercent <= 100)) { toast("退信率阈值需在 1–100 之间", "error"); return; }
  if (!(windowDays >= 1 && windowDays <= 90)) { toast("统计窗口需在 1–90 天之间", "error"); return; }
  if (!(minSample >= 1 && minSample <= 10000)) { toast("最小样本需在 1–10000 之间", "error"); return; }
  if (!enabled && !await confirmAction({
    title: "关闭退信保护？",
    message: "关闭后即使退信率很高，系统也会继续外发。",
    consequences: ["高退信率会被邮箱服务商限流甚至封停发信", "发信域名信誉受损后恢复很慢", "建议排查完退信原因后尽快重新开启"],
    confirmLabel: "确认关闭",
    tone: "warning"
  })) return;
  setButtonPending(button ?? null, true, "保存", "保存中");
  try {
    const view = await api<BounceGuardView>("/api/email-delivery/bounce-guard", {
      method: "PUT",
      body: JSON.stringify({ enabled, maxBouncePercent, windowDays, minSample })
    });
    renderBounceGuard(view);
    toast(enabled ? "退信保护已保存，立即生效" : "退信保护已关闭", "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存退信保护失败", "error");
  } finally {
    setButtonPending(button ?? null, false, "保存", "保存中");
  }
}

let senderMailboxes: SenderMailboxView[] = [];

export async function loadSenderMailboxes() {
  const list = qs<HTMLElement>("#mailboxPoolList");
  if (!list) return;
  try {
    let result = await api<{ mailboxes: SenderMailboxView[] }>("/api/sender-mailboxes");
    // 迁移期兜底：旧版「默认发件邮箱」还存在 users.* 里、池为空时，
    // 邮件中心账号接口会把它自动导入成一个账号——先拉一次触发导入再重读列表。
    if (!result.mailboxes?.length && state.user?.smtpHost) {
      await api("/api/mail-center/accounts").catch(() => undefined);
      result = await api<{ mailboxes: SenderMailboxView[] }>("/api/sender-mailboxes");
    }
    senderMailboxes = result.mailboxes || [];
  } catch (error) {
    senderMailboxes = [];
    list.innerHTML = `<div class="empty-cell">读取失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</div>`;
    return;
  }
  renderSenderMailboxList();
}

function renderSenderMailboxList() {
  const list = qs<HTMLElement>("#mailboxPoolList");
  if (!list) return;
  if (!senderMailboxes.length) {
    list.innerHTML = `<div class="mailbox-pool-empty">还没有邮箱账号。点「＋ 添加邮箱」登记 SMTP/IMAP 后，写信、自动发信与收件同步都用这里的账号。</div>`;
    return;
  }
  list.innerHTML = senderMailboxes.map((mailbox, index) => {
    const status = !mailbox.enabled ? `<span class="badge gray">已停用</span>`
      : mailbox.hasSmtpPassword ? `<span class="badge green">可用</span>`
      : `<span class="badge amber">缺授权码</span>`;
    const isDefault = mailbox.isDefault ?? (mailbox.email.toLowerCase() === (state.user?.outboundEmail || "").toLowerCase());
    const primary = isDefault ? `<span class="badge green">默认</span>` : "";
    const dkim = mailbox.dkimDomain && mailbox.dkimSelector ? `<span class="badge" style="background:#f0fdf4;border-color:#bbf7d0;color:#15803d">DKIM ${escapeHtml(mailbox.dkimSelector)}.${escapeHtml(mailbox.dkimDomain)}</span>` : "";
    const signature = mailbox.signature?.trim()
      ? `<span class="badge" style="background:#eef4fc;border-color:#d5e3f6;color:#1f5fa8" title="${escapeHtml(mailbox.signature)}">专属尾缀</span>`
      : `<span class="badge gray" title="沿用「邮件签名」里的账号级签名">通用尾缀</span>`;
    return `<div class="mailbox-pool-row${mailbox.enabled ? "" : " is-off"}" style="--mb-i:${index}">
      <div class="mailbox-pool-main">
        <b>${escapeHtml(mailbox.label || mailbox.email)}${primary}</b>
        <small>${escapeHtml(mailbox.email)} · ${escapeHtml(mailbox.smtpHost)}:${mailbox.smtpPort} ${mailbox.smtpSecure ? "SSL" : "STARTTLS"}${mailbox.fromName ? ` · 发件人 ${escapeHtml(mailbox.fromName)}` : ""} · 日限额 ${mailbox.dailyLimit || 50}</small>
        ${dkim ? `<small>${dkim}</small>` : ""}
        <small>${signature}</small>
      </div>
      <div class="mailbox-pool-side">${status}</div>
      <div class="mailbox-pool-actions">
        ${isDefault ? "" : `<button class="btn tiny" data-mailbox-default="${escapeHtml(mailbox.id)}" ${mailbox.enabled ? "" : "disabled title=\"已停用，先启用\""}>设为默认</button>`}
        <button class="btn tiny" data-mailbox-test="${escapeHtml(mailbox.id)}" ${mailbox.hasSmtpPassword ? "" : "disabled title=\"缺授权码，先编辑补全\""}>测试</button>
        <button class="btn tiny" data-mailbox-edit="${escapeHtml(mailbox.id)}">编辑</button>
        <button class="btn tiny danger subtle" data-mailbox-remove="${escapeHtml(mailbox.id)}">删除</button>
      </div>
    </div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-mailbox-default]", list).forEach((button) => button.addEventListener("click", () => void setMailboxDefault(button.dataset.mailboxDefault || "", button)));
  qsa<HTMLButtonElement>("[data-mailbox-test]", list).forEach((button) => button.addEventListener("click", () => void testSenderMailbox(button.dataset.mailboxTest || "", button)));
  qsa<HTMLButtonElement>("[data-mailbox-edit]", list).forEach((button) => button.addEventListener("click", () => {
    const mailbox = senderMailboxes.find((row) => row.id === button.dataset.mailboxEdit);
    if (mailbox) openSenderMailboxModal(mailbox);
  }));
  qsa<HTMLButtonElement>("[data-mailbox-remove]", list).forEach((button) => button.addEventListener("click", () => void removeSenderMailbox(button.dataset.mailboxRemove || "")));
}

/** 设为默认：后端把该邮箱的 SMTP/IMAP/DKIM/发件人同步回账号级发件配置 */
export async function setMailboxDefault(id: string, button?: HTMLButtonElement) {
  const mailbox = senderMailboxes.find((row) => row.id === id);
  if (!mailbox) return;
  if (button) setButtonPending(button, true, "设为默认", "设置中");
  try {
    const { user } = await api<{ user: User }>(`/api/sender-mailboxes/${encodeURIComponent(id)}/make-default`, { method: "POST", body: "{}" });
    updateStoredUser(user);
    toast(`默认发件身份已切换为 ${mailbox.email}`, "success");
    renderProfile();
    await loadSenderMailboxes();
  } catch (error) {
    toast(error instanceof Error ? error.message : "设为默认失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "设为默认", "设置中");
  }
}

export function openSenderMailboxModal(mailbox?: SenderMailboxView, opts?: { onSaved?: (mailboxId: string, isNew: boolean) => void | Promise<void> }) {
  const title = mailbox ? "编辑邮箱账号" : "添加邮箱账号";
  const body = `
    <div class="form-grid">
      <div class="form-field"><label>备注名称</label><input id="smbLabel" placeholder="例如 主邮箱 / 询盘专用" value="${escapeHtml(mailbox?.label || "")}"></div>
      <div class="form-field"><label>发件邮箱 *</label><input id="smbEmail" placeholder="sales@your-company.com" value="${escapeHtml(mailbox?.email || "")}"></div>
      <div class="form-field"><label>发件人显示名</label><input id="smbFromName" placeholder="留空 = 沿用账号发件人名称" value="${escapeHtml(mailbox?.fromName || "")}"></div>
      <div class="form-field full"><label>署名尾缀（这个邮箱专属）</label><textarea id="smbSignature" rows="4" placeholder="留空 = 沿用「邮箱设置 → 邮件签名」的账号级签名&#10;Best regards,&#10;Kevin&#10;ZHUHAI LONGTEC CO.,LTD">${escapeHtml(mailbox?.signature || "")}</textarea><small>写信、回复、转发时自动带在正文末尾；每个发件邮箱可以不一样，切换账号时尾缀跟着换。</small></div>
      <div class="form-field"><label>SMTP服务器 *</label><input id="smbSmtpHost" placeholder="smtp.exmail.qq.com" value="${escapeHtml(mailbox?.smtpHost || "")}"></div>
      <div class="form-field"><label>SMTP端口</label><input id="smbSmtpPort" type="number" min="1" max="65535" value="${mailbox?.smtpPort || 465}"></div>
      <div class="form-field"><label>加密方式</label><select id="smbSmtpSecure"><option value="true"${mailbox?.smtpSecure === false ? "" : " selected"}>SSL/TLS（465）</option><option value="false"${mailbox?.smtpSecure === false ? " selected" : ""}>STARTTLS/普通（587）</option></select></div>
      <div class="form-field"><label>SMTP账号 *</label><input id="smbSmtpUser" placeholder="通常与发件邮箱一致" value="${escapeHtml(mailbox?.smtpUser || "")}"></div>
      <div class="form-field"><label>SMTP授权码 ${mailbox ? "（留空 = 保留原授权码）" : "*"}</label><input id="smbSmtpPassword" type="password" placeholder="${mailbox ? "输入后覆盖保存" : "授权码/客户端专用密码"}"></div>
      <div class="form-field"><label>IMAP服务器（可选）</label><input id="smbImapHost" placeholder="留空 = 按 SMTP 主机推导" value="${escapeHtml(mailbox?.imapHost || "")}"></div>
      <div class="form-field"><label>IMAP端口</label><input id="smbImapPort" type="number" min="1" max="65535" value="${mailbox?.imapPort || 993}"></div>
      <div class="form-field"><label>IMAP账号（可选）</label><input id="smbImapUser" placeholder="留空 = 同 SMTP 账号" value="${escapeHtml(mailbox?.imapUser || "")}"></div>
      <div class="form-field"><label>IMAP授权码（可选）</label><input id="smbImapPassword" type="password" placeholder="留空 = 同 SMTP 授权码"></div>
      <div class="form-field"><label>收件同步</label><select id="smbSyncEnabled"><option value="1"${mailbox?.syncEnabled !== false ? " selected" : ""}>开启（按频率自动收件）</option><option value="0"${mailbox?.syncEnabled === false ? " selected" : ""}>暂停</option></select></div>
      <div class="form-field"><label>自动同步频率</label><select id="smbSyncInterval">
        ${[15, 30, 60, 120, 240, 1440].map((minutes) => `<option value="${minutes}"${Number(mailbox?.syncIntervalMinutes || 60) === minutes ? " selected" : ""}>${minutes === 60 ? "每小时" : minutes === 1440 ? "每天" : minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`}</option>`).join("")}
      </select></div>
      <div class="form-field"><label>DKIM 域名（可选）</label><input id="smbDkimDomain" placeholder="留空 = 不签名" value="${escapeHtml(mailbox?.dkimDomain || "")}"></div>
      <div class="form-field"><label>DKIM Selector（可选）</label><input id="smbDkimSelector" placeholder="例如 s1" value="${escapeHtml(mailbox?.dkimSelector || "")}"></div>
      <div class="form-field full"><label>DKIM 私钥 ${mailbox ? "（留空 = 保留原私钥）" : "（可选）"}</label><textarea id="smbDkimPrivateKey" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"></textarea><small>DNS 侧需同步添加 &lt;selector&gt;._domainkey 的 TXT 公钥记录；配置后该邮箱发出的开发信自动带 DKIM 签名。</small></div>
      <div class="form-field"><label>单账号日限额</label><input id="smbDailyLimit" type="number" min="1" max="500" value="${mailbox?.dailyLimit || 50}"><small>轮换时该邮箱当日发到上限即自动跳过，防止单箱过量被封；全部邮箱到限则整批暂停。</small></div>
      <label class="form-field" style="display:flex;gap:8px;align-items:center"><input id="smbEnabled" type="checkbox"${!mailbox || mailbox.enabled ? " checked" : ""}>启用（参与轮换）</label>
      <div class="form-field full"><div class="mc-probe" id="smbProbe" hidden></div></div>
    </div>`;
  const foot = `<button class="btn" id="smbTestConn" type="button">测试连接</button><span class="modal-foot-spacer"></span><button class="btn" data-modal-close>取消</button><button class="btn primary" id="smbSaveButton">${mailbox ? "保存修改" : "添加"}</button>`;
  openModal(title, body, foot, { closeOnBackdrop: false });
  qs<HTMLElement>("#appModal .modal")?.classList.add("sender-mailbox-modal");
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLButtonElement>("#smbSaveButton")?.addEventListener("click", (event) => void saveSenderMailboxModal(event.currentTarget as HTMLButtonElement, mailbox?.id, opts?.onSaved));
  qs<HTMLButtonElement>("#smbTestConn")?.addEventListener("click", (event) => void testSenderMailboxConnection(event.currentTarget as HTMLButtonElement, mailbox?.id));
}

interface MailboxProbeSide {
  ok: boolean;
  host: string;
  port: number;
  message: string;
  ms?: number;
}

/** 「测试连接」：拿表单当前值直接探一次，不用先保存。SMTP 走 verify、IMAP 只读打开收件箱 */
async function testSenderMailboxConnection(button?: HTMLButtonElement, mailboxId?: string) {
  const email = qs<HTMLInputElement>("#smbEmail")?.value.trim() || "";
  const password = qs<HTMLInputElement>("#smbSmtpPassword")?.value || "";
  const smtpHost = qs<HTMLInputElement>("#smbSmtpHost")?.value.trim() || "";
  const smtpPort = Number(qs<HTMLInputElement>("#smbSmtpPort")?.value || 465);
  const imapHost = qs<HTMLInputElement>("#smbImapHost")?.value.trim() || "";
  if (!email || !email.includes("@")) { toast("请先填写邮箱地址", "error"); return; }
  if (!password && !mailboxId) { toast("请先填写 SMTP 授权码，测试连接需要它", "error"); return; }
  const out = qs<HTMLElement>("#smbProbe");
  if (button?.disabled) return;
  if (out) {
    out.hidden = false;
    out.className = "mc-probe is-running";
    out.innerHTML = `<b>正在连 SMTP 与 IMAP…</b><span>两个通道一起探，最多等 20 秒</span>`;
  }
  setButtonPending(button ?? null, true, "测试连接", "测试中…");
  try {
    const result = await api<{ ok: boolean; email: string; smtp: MailboxProbeSide; imap: MailboxProbeSide }>(
      "/api/mail-center/test-connection",
      { method: "POST", body: JSON.stringify({ mailboxId: mailboxId || "", email, password, smtpHost, smtpPort, imapHost }) }
    );
    const line = (label: string, side: MailboxProbeSide | undefined) => {
      if (!side) return "";
      const ok = Boolean(side.ok);
      const where = `${side.host || "—"}${side.port ? `:${side.port}` : ""}`;
      return `<div class="mc-probe-line ${ok ? "is-ok" : "is-bad"}">
        <b>${label}</b>
        <span class="mc-probe-state">${ok ? "通过" : "失败"}</span>
        <span class="mc-probe-msg">${escapeHtml(side.message || "")}</span>
        <i>${escapeHtml(where)}${side.ms ? ` · ${(side.ms / 1000).toFixed(1)}s` : ""}</i>
      </div>`;
    };
    if (out) {
      out.className = `mc-probe ${result.ok ? "is-ok" : "is-bad"}`;
      out.innerHTML = `${line("SMTP 发信", result.smtp)}${line("IMAP 收信", result.imap)}`;
    }
    toast(result.ok ? "两个通道都连通了，可以保存" : "有通道没通，按下面提示改完再测", result.ok ? "success" : "error");
  } catch (error) {
    const message = error instanceof Error ? error.message : "测试失败";
    if (out) {
      out.hidden = false;
      out.className = "mc-probe is-bad";
      out.innerHTML = `<div class="mc-probe-line is-bad"><b>配置</b><span class="mc-probe-state">失败</span><span class="mc-probe-msg">${escapeHtml(message)}</span></div>`;
    }
    toast(message, "error");
  } finally {
    setButtonPending(button ?? null, false, "测试连接", "测试连接");
  }
}

async function saveSenderMailboxModal(button?: HTMLButtonElement, id?: string, onSaved?: (mailboxId: string, isNew: boolean) => void | Promise<void>) {
  const payload = {
    label: qs<HTMLInputElement>("#smbLabel")?.value.trim() || "",
    email: qs<HTMLInputElement>("#smbEmail")?.value.trim() || "",
    fromName: qs<HTMLInputElement>("#smbFromName")?.value.trim() || "",
    signature: qs<HTMLTextAreaElement>("#smbSignature")?.value.trim() || "",
    smtpHost: qs<HTMLInputElement>("#smbSmtpHost")?.value.trim() || "",
    smtpPort: Number(qs<HTMLInputElement>("#smbSmtpPort")?.value || 465),
    smtpSecure: qs<HTMLSelectElement>("#smbSmtpSecure")?.value !== "false",
    smtpUser: qs<HTMLInputElement>("#smbSmtpUser")?.value.trim() || "",
    smtpPassword: qs<HTMLInputElement>("#smbSmtpPassword")?.value || "",
    imapHost: qs<HTMLInputElement>("#smbImapHost")?.value.trim() || "",
    imapPort: Number(qs<HTMLInputElement>("#smbImapPort")?.value || 993),
    imapUser: qs<HTMLInputElement>("#smbImapUser")?.value.trim() || "",
    imapPassword: qs<HTMLInputElement>("#smbImapPassword")?.value || "",
    dkimDomain: qs<HTMLInputElement>("#smbDkimDomain")?.value.trim() || "",
    dkimSelector: qs<HTMLInputElement>("#smbDkimSelector")?.value.trim() || "",
    // 私钥只在填写时提交：不传 = 编辑时保留原私钥（后端 undefined 语义）
    ...(qs<HTMLTextAreaElement>("#smbDkimPrivateKey")?.value ? { dkimPrivateKey: qs<HTMLTextAreaElement>("#smbDkimPrivateKey")!.value } : {}),
    dailyLimit: Number(qs<HTMLInputElement>("#smbDailyLimit")?.value || 50),
    enabled: qs<HTMLInputElement>("#smbEnabled")?.checked ?? true
  };
  if (!payload.email || !payload.smtpHost || !payload.smtpUser || (!id && !payload.smtpPassword)) {
    toast("带 * 的字段都要填写（编辑时授权码可留空保留）", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = id ? "保存中" : "添加中";
  }
  try {
    const created = await api<{ mailbox?: { id: string } }>(id ? `/api/sender-mailboxes/${encodeURIComponent(id)}` : "/api/sender-mailboxes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    // 收件同步开关与频率走邮件中心的账号级接口（同一行数据，只是另一个写路径）
    const mailboxId = id || created.mailbox?.id || "";
    if (mailboxId) {
      await api(`/api/mail-center/accounts/${encodeURIComponent(mailboxId)}/sync`, {
        method: "PATCH",
        body: JSON.stringify({
          syncEnabled: qs<HTMLSelectElement>("#smbSyncEnabled")?.value !== "0",
          syncIntervalMinutes: Number(qs<HTMLSelectElement>("#smbSyncInterval")?.value || 60)
        })
      }).catch(() => undefined);
    }
    closeModal();
    toast(id ? "邮箱账号已更新" : "邮箱已添加", "success");
    await loadSenderMailboxes();
    await onSaved?.(mailboxId, !id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
    if (button) {
      button.disabled = false;
      button.textContent = id ? "保存修改" : "添加";
    }
  }
}

async function testSenderMailbox(id: string, button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ to: string; simulated?: boolean }>(`/api/sender-mailboxes/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" });
    toast(result.simulated ? "测试邮件已生成（测试环境未外发）" : `测试邮件已发送到 ${result.to}，请查收`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "测试";
    }
  }
}

async function removeSenderMailbox(id: string) {
  const mailbox = senderMailboxes.find((row) => row.id === id);
  const ok = await confirmAction({
    title: `删除发件邮箱「${mailbox?.label || mailbox?.email || id}」`,
    message: "删除后轮换序列里不再使用这个邮箱，正在运行的方案会自动跳过它。",
    consequences: ["该邮箱从发件邮箱池移除", "已发出的邮件与台账记录不受影响"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    await api(`/api/sender-mailboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("发件邮箱已删除", "success");
    await loadSenderMailboxes();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}

function collectDevelopmentEmailDraft() {
  const sender = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || state.user?.name || "GoodJob Sales";
  const from = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || state.user?.outboundEmail || "";
  const signature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  return {
    to: qs<HTMLInputElement>("#devEmailTo")?.value.trim() || "",
    company: qs<HTMLInputElement>("#devEmailCompany")?.value.trim() || "",
    subject: qs<HTMLInputElement>("#devEmailSubject")?.value.trim() || "",
    body: qs<HTMLTextAreaElement>("#devEmailBody")?.value.trim() || "",
    sender,
    from,
    signature
  };
}

function renderDevelopmentEmailPreview() {
  const draft = collectDevelopmentEmailDraft();
  const preview = qs<HTMLElement>("#devEmailPreview");
  if (!preview) return;
  preview.textContent = [
    `From: ${draft.sender}${draft.from ? ` <${draft.from}>` : " <未绑定>"}`,
    `To: ${draft.to || "未填写"}`,
    `Subject: ${draft.subject || "未填写"}`,
    "",
    draft.body || "填写内容后可预览开发信。"
  ].join("\n");
}

export function updateStoredUser(user: User) {
  state.user = user;
  localStorage.setItem(storage.user, JSON.stringify(user));
  applyAuthedUser(user);
}

export async function saveProfileEmailBinding(button?: HTMLButtonElement, clearSmtpPassword = false, clearImapPassword = false) {
  // 邮箱账号配置统一改走「邮箱账号列表 / make-default」，这里保留的 PATCH
  // 只改账号级字段（签名）；页面已移除的输入框一律回退 state.user，防误清空。
  const current = state.user;
  const readInput = (selector: string, fallback: string) => qs<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)?.value.trim() ?? fallback;
  const outboundEmail = clearSmtpPassword ? "" : readInput("#profileOutboundEmail", current?.outboundEmail || "");
  const emailSenderName = clearSmtpPassword ? "" : readInput("#profileSenderName", current?.emailSenderName || "");
  const emailSignature = clearSmtpPassword ? "" : readInput("#profileEmailSignature", current?.emailSignature || "");
  const smtpHost = clearSmtpPassword ? "" : readInput("#profileSmtpHost", current?.smtpHost || "");
  const smtpPort = clearSmtpPassword ? 465 : Number(qs<HTMLInputElement>("#profileSmtpPort")?.value || current?.smtpPort || 465);
  const smtpSecure = clearSmtpPassword ? true : qs<HTMLSelectElement>("#profileSmtpSecure")?.value !== "false";
  const smtpUser = clearSmtpPassword ? "" : readInput("#profileSmtpUser", current?.smtpUser || "");
  const smtpPassword = qs<HTMLInputElement>("#profileSmtpPassword")?.value || "";
  const inboundSyncEnabled = qs<HTMLInputElement>("#profileImapEnabled")?.checked ?? Boolean(current?.inboundSyncEnabled);
  const imapHost = clearSmtpPassword ? "" : readInput("#profileImapHost", current?.imapHost || "");
  const imapPort = clearSmtpPassword ? 993 : Number(qs<HTMLInputElement>("#profileImapPort")?.value || current?.imapPort || 993);
  const imapSecure = clearSmtpPassword ? true : qs<HTMLSelectElement>("#profileImapSecure")?.value !== "false";
  const imapUser = clearSmtpPassword ? "" : readInput("#profileImapUser", current?.imapUser || "");
  const imapPassword = qs<HTMLInputElement>("#profileImapPassword")?.value || "";
  const dkimDomain = clearSmtpPassword ? "" : readInput("#profileDkimDomain", current?.dkimDomain || "");
  const dkimSelector = clearSmtpPassword ? "" : readInput("#profileDkimSelector", current?.dkimSelector || "");
  const dkimPrivateKey = clearSmtpPassword ? "" : qs<HTMLTextAreaElement>("#profileDkimPrivateKey")?.value || "";
  const idleText = clearSmtpPassword ? "取消默认身份" : "保存";
  if (button) {
    button.disabled = true;
    button.textContent = clearSmtpPassword ? "处理中" : "保存中";
  }
  try {
    const result = await api<{ user: User }>("/api/profile/email-binding", {
      method: "PATCH",
      body: JSON.stringify({ outboundEmail, emailSenderName, emailSignature, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, clearSmtpPassword, imapHost, imapPort, imapSecure, imapUser, imapPassword, clearImapPassword, dkimDomain, dkimSelector, dkimPrivateKey, clearDkimPrivateKey: Boolean(clearSmtpPassword), inboundSyncEnabled })
    });
    updateStoredUser(result.user);
    if (clearImapPassword && !clearSmtpPassword) toast("IMAP 密码已清除");
    else toast(outboundEmail ? "邮箱设置已保存" : "默认发件身份已取消");
    renderProfile();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = idleText;
    }
  }
}

export async function changeProfilePassword(button?: HTMLButtonElement) {
  const currentPassword = qs<HTMLInputElement>("#profileCurrentPassword")?.value || "";
  const newPassword = qs<HTMLInputElement>("#profileNewPassword")?.value || "";
  const confirmPassword = qs<HTMLInputElement>("#profileConfirmPassword")?.value || "";
  if (!currentPassword) {
    toast("请输入当前密码", "error");
    return;
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    toast("新密码长度需要为 8 至 128 位", "error");
    return;
  }
  if (newPassword !== confirmPassword) {
    toast("两次输入的新密码不一致", "error");
    return;
  }
  if (button) setButtonPending(button, true, "修改登录密码", "保存中");
  try {
    await api<{ requiresRelogin: boolean; message: string }>("/api/profile/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    ["#profileCurrentPassword", "#profileNewPassword", "#profileConfirmPassword"].forEach((selector) => setFieldValue(selector, ""));
    setFieldValue("#loginPassword", "");
    localStorage.removeItem(storage.user);
    state.user = null;
    state.iamCapabilities = null;
    document.body.classList.remove("is-authenticated");
    toast("密码已修改，请使用新密码重新登录", "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "密码修改失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "修改登录密码", "保存中");
  }
}

export async function clearProfileEmailBinding(button?: HTMLButtonElement) {
  if (!await confirmAction({
    title: "取消默认发件身份",
    message: "将清除账号级的默认发件配置；账号列表里的邮箱不受影响。",
    consequences: ["开发信、回信匹配与测试邮件将没有默认身份可用", "账号级邮件签名会被清空", "再次「设为默认」即可恢复"],
    confirmLabel: "取消默认"
  })) return;
  await saveProfileEmailBinding(button, true);
}

export async function clearProfileImapPassword(button?: HTMLButtonElement) {
  if (!await confirmAction({
    title: "清除 IMAP 授权码",
    message: "将清除当前账号保存的收信授权码。",
    consequences: ["收信监听将在下次同步时停止", "重新填写有效授权码后才会恢复"],
    confirmLabel: "清除授权码"
  })) return;
  setFieldValue("#profileImapPassword", "");
  await saveProfileEmailBinding(button, false, true);
}

export async function sendProfileTestEmail(button?: HTMLButtonElement) {
  const to = qs<HTMLInputElement>("#profileTestEmailTo")?.value.trim() || "";
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ ok: boolean; simulated: boolean; messageId?: string; to?: string }>("/api/profile/test-email", {
      method: "POST",
      body: JSON.stringify({ to })
    });
    toast(result.simulated ? "测试邮件已生成（测试环境未外发）" : "测试邮件已发送，请检查发件邮箱收件箱");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试邮件发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送测试邮件";
    }
  }
}

export async function testProfileImap(button?: HTMLButtonElement) {
  if (button) setButtonPending(button, true, "测试 IMAP", "连接中");
  try {
    await api<{ ok: boolean }>("/api/profile/inbound-mail/test", { method: "POST" });
    toast("IMAP 连接成功，可以接收回信和退信");
  } catch (error) {
    toast(error instanceof Error ? error.message : "IMAP 连接失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "测试 IMAP", "连接中");
  }
}

export async function checkProfileEmailDomain(button?: HTMLButtonElement) {
  if (button) setButtonPending(button, true, "域名检测", "检测中");
  try {
    const result = await api<{ authentication: {
      domain: string;
      ready: boolean;
      spf: { ok: boolean };
      dmarc: { ok: boolean };
      dkim: { ok: boolean; selector: string; definitive: boolean };
    } }>("/api/profile/email-domain-authentication");
    const auth = result.authentication;
    const line = (label: string, ok: boolean, detail = "") =>
      `<div class="profile-info-row"><span>${escapeHtml(label)}</span><b>${badge(ok ? "通过" : "待配置", ok ? "green" : "amber")} ${escapeHtml(detail)}</b></div>`;
    openModal(`发件域名检测 · ${auth.domain}`, `
      <div class="profile-info-list">
        ${line("SPF", auth.spf.ok)}
        ${line("DMARC", auth.dmarc.ok)}
        ${line("DKIM", auth.dkim.ok, auth.dkim.selector ? `selector: ${auth.dkim.selector}` : auth.dkim.definitive ? "指定 selector 未发现" : "请向邮箱服务商确认 selector")}
      </div>
      <div class="form-hint" style="margin-top:12px">检测通过可显著降低进入垃圾邮件的风险，但不能保证送达；DKIM selector 由邮箱服务商提供。</div>
    `, `<button class="btn primary" data-modal-close>关闭</button>`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "域名检测失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "域名检测", "检测中");
  }
}
