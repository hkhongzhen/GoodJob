/**
 * 名片 OCR、AI 配置。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { state } from "../prototype-api";
import { type AiModelConfig, type OcrJob } from "./models";
import { loadLeadProviders } from "./dashboard";
import { syncLeadFinderStartState } from "./prospecting";
import { aiProviderPresets, badge, escapeHtml, ocrBatchJobs, qs, qsa, setFieldValue } from "./shared";
import { api, toast } from "./ui";
import { reloadLeads } from "./leads";
import { renderLeadFinder } from "./lead-sources";

let ocrLocalPreviewUrl = "";
let ocrPreviewRevision = 0;
let ocrBusy = false;
let ocrBatchRunning = false;

export function renderOcr(job: OcrJob) {
  const fields = job.fields;
  const mapping: Record<string, string> = {
    company: "公司名",
    contact: "联系人",
    title: "职位",
    email: "邮箱",
    whatsapp: "WhatsApp",
    wechat: "微信",
    phone: "电话",
    country: "国家",
    city: "城市"
  };
  const cards = qs<HTMLElement>("#business-card .ocr-fields");
  if (!cards) return;
  cards.innerHTML = Object.entries(mapping).map(([key, label]) => `<div class="field-card"><input type="checkbox" checked data-ocr-field="${escapeHtml(key)}"><div><label>${label}</label><input type="text" value="${escapeHtml(fields[key])}"></div></div>`).join("");
  const statusRows = qsa<HTMLElement>("#business-card .sync-row");
  const hasRecognizedFields = Object.values(fields).some((value) => String(value || "").trim());
  const effectiveStatus = !job.hasImage && !hasRecognizedFields ? "waiting" : job.status;
  const statusLabel = effectiveStatus === "synced"
    ? "已同步"
    : effectiveStatus === "recognized"
      ? "识别完成"
      : effectiveStatus === "failed"
        ? "识别失败"
      : effectiveStatus === "uploaded"
        ? "已加载，待识别"
        : "等待名片";
  if (statusRows[0]) statusRows[0].innerHTML = `<span>识别状态</span><b>${statusLabel}</b>${badge(job.confidence > 0 ? `${job.confidence}% 置信度` : "--", job.confidence > 0 ? "green" : "")}`;
  const currentTask = qs<HTMLElement>("#ocrCurrentTaskValue");
  const recognizedFields = qs<HTMLElement>("#ocrRecognizedFieldsValue");
  const confidence = qs<HTMLElement>("#ocrConfidenceValue");
  const syncState = qs<HTMLElement>("#ocrSyncStateValue");
  if (currentTask) currentTask.textContent = effectiveStatus === "synced" ? "已同步" : hasRecognizedFields ? "已识别" : job.hasImage ? "待识别" : "待上传";
  if (recognizedFields) recognizedFields.textContent = String(Object.values(fields).filter((value) => String(value || "").trim()).length);
  if (confidence) confidence.textContent = `${job.confidence}%`;
  if (syncState) syncState.textContent = effectiveStatus === "synced" ? "已同步" : "未同步";
  const uploadBadge = qs<HTMLElement>("#ocrUploadBadge");
  if (uploadBadge) uploadBadge.textContent = job.hasImage ? "名片已安全加载" : "等待加载名片";
  const removeButton = qs<HTMLButtonElement>("#ocrRemoveButton");
  if (removeButton) removeButton.hidden = !job.hasImage;
  const recognizeButton = qs<HTMLButtonElement>("#ocrRecognizeButton");
  if (recognizeButton) recognizeButton.disabled = ocrBusy || !job.hasImage;
  const card = qs<HTMLElement>("#ocrPreviewCard");
  if (card) {
    const imageSource = ocrLocalPreviewUrl || (job.imageUrl ? `${job.imageUrl}?v=${ocrPreviewRevision}` : "");
    card.innerHTML = imageSource
      ? `<img src="${escapeHtml(imageSource)}" alt="已加载的名片图片">`
      : `<div class="ocr-card-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5a2 2 0 0 1 2-2h2M16 3h2a2 2 0 0 1 2 2v2M20 17v2a2 2 0 0 1-2 2h-2M8 21H6a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/></svg><h2>尚未加载名片</h2><p>支持 PNG、JPG、WebP，单张不超过 2 MB</p></div>`;
  }
  const hint = qs<HTMLElement>("#ocrRecognitionHint");
  if (hint && !hint.classList.contains("error")) {
    hint.textContent = (effectiveStatus === "recognized" || effectiveStatus === "synced") && hasRecognizedFields
      ? "识别结果可人工修正，勾选需要同步的字段"
      : job.hasImage
        ? "可重新识别，或直接人工填写右侧字段"
        : "图片将由当前账号配置的视觉模型识别";
  }
  const mappingRows = qsa<HTMLTableRowElement>("#business-card .matrix-grid .mini-table tbody tr").slice(0, 4);
  const mappingStates = [
    Boolean(fields.company?.trim()),
    Boolean(fields.contact?.trim() || fields.title?.trim()),
    Boolean(fields.email?.trim() || fields.phone?.trim() || fields.whatsapp?.trim() || fields.wechat?.trim()),
    Boolean(fields.country?.trim() || fields.city?.trim())
  ];
  mappingRows.forEach((row, index) => {
    const cell = row.lastElementChild as HTMLElement | null;
    if (cell) cell.innerHTML = badge(mappingStates[index] ? "已识别" : "待补充", mappingStates[index] ? "green" : "");
  });
}

function setOcrHint(message: string, error = false) {
  const hint = qs<HTMLElement>("#ocrRecognitionHint");
  if (!hint) return;
  hint.textContent = message;
  hint.classList.toggle("error", error);
}

function setOcrBusy(busy: boolean, phase: "upload" | "recognize" = "recognize") {
  ocrBusy = busy;
  const loadButton = qs<HTMLButtonElement>("#ocrLoadButton");
  const recognizeButton = qs<HTMLButtonElement>("#ocrRecognizeButton");
  const removeButton = qs<HTMLButtonElement>("#ocrRemoveButton");
  const fileInput = qs<HTMLInputElement>("#ocrFileInput");
  if (loadButton) {
    loadButton.disabled = busy;
    loadButton.textContent = busy && phase === "upload" ? "加载中" : "加载名片";
  }
  if (recognizeButton) {
    recognizeButton.disabled = busy || !state.ocrJob?.hasImage;
    recognizeButton.textContent = busy && phase === "recognize" ? "识别中" : "重新识别";
  }
  if (removeButton) removeButton.disabled = busy;
  if (fileInput) fileInput.disabled = busy;
}

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("名片图片读取失败"));
    reader.readAsDataURL(file);
  });
}

export function activeOcrJobId() {
  return state.ocrJob?.id || "current";
}

function ocrBatchStatusLabel(job: OcrJob) {
  if (job.status === "synced") return "已同步";
  if (job.status === "recognized") return "识别完成";
  if (job.status === "failed") return "失败";
  if (job.status === "processing") return "识别中";
  if (job.status === "uploaded") return "已上传";
  if (job.status === "uploading") return "上传中";
  return "排队中";
}

function renderOcrBatch() {
  const total = ocrBatchJobs.length;
  const completed = ocrBatchJobs.filter((job) => ["recognized", "synced", "failed"].includes(job.status)).length;
  const failed = ocrBatchJobs.filter((job) => job.status === "failed").length;
  const synced = ocrBatchJobs.filter((job) => job.status === "synced").length;
  const setText = (id: string, value: string | number) => { const node = qs<HTMLElement>(id); if (node) node.textContent = String(value); };
  setText("#ocrBatchTotal", total);
  setText("#ocrBatchCompleted", completed);
  setText("#ocrBatchFailed", failed);
  setText("#ocrBatchSynced", synced);
  const progress = qs<HTMLElement>("#ocrBatchProgressBar");
  if (progress) progress.style.width = `${total ? Math.round(completed / total * 100) : 0}%`;
  const retry = qs<HTMLButtonElement>("#ocrBatchRetryButton");
  const sync = qs<HTMLButtonElement>("#ocrBatchSyncButton");
  const clear = qs<HTMLButtonElement>("#ocrBatchClearButton");
  if (retry) retry.disabled = ocrBatchRunning || !ocrBatchJobs.some((job) => job.status === "failed" && job.hasImage);
  if (sync) sync.disabled = ocrBatchRunning || !ocrBatchJobs.some((job) => job.status === "recognized");
  if (clear) clear.disabled = ocrBatchRunning || !total;
  const list = qs<HTMLElement>("#ocrBatchList");
  if (!list) return;
  if (!ocrBatchJobs.length) {
    list.innerHTML = `<div class="ocr-batch-empty">选择一个包含名片图片的文件夹开始批量处理</div>`;
    return;
  }
  list.innerHTML = `<div class="ocr-batch-row ocr-batch-header"><span></span><span>文件</span><span>状态</span><span>识别结果</span><span>置信度</span><span>操作</span></div>` + ocrBatchJobs.map((job) => {
    const fields = job.fields || {};
    const company = fields.company || "未识别公司";
    const contact = [fields.contact, fields.title].filter(Boolean).join(" · ") || job.errorMessage || "等待处理";
    const stateClass = job.status === "failed" ? "failed" : job.status === "recognized" ? "recognized" : job.status === "synced" ? "synced" : ["processing", "uploading"].includes(job.status) ? "processing" : "";
    const retryButton = job.status === "failed" && job.hasImage ? `<button class="btn" type="button" data-ocr-batch-retry="${escapeHtml(job.id)}">重试</button>` : "";
    const syncButton = job.status === "recognized" ? `<button class="btn primary" type="button" data-ocr-batch-sync="${escapeHtml(job.id)}">同步</button>` : "";
    return `<div class="ocr-batch-row">
      <input type="checkbox" data-ocr-batch-select="${escapeHtml(job.id)}" ${job.status === "recognized" ? "checked" : ""} aria-label="选择 ${escapeHtml(job.sourceFileName || job.id)}">
      <div class="ocr-batch-file" title="${escapeHtml(job.sourceFileName || job.id)}"><b>${escapeHtml(job.sourceFileName || job.id)}</b><small>${escapeHtml(job.batchId || "批量任务")}</small></div>
      <span class="ocr-batch-state ${stateClass}">${ocrBatchStatusLabel(job)}</span>
      <div class="ocr-batch-result" title="${escapeHtml(job.errorMessage || contact)}"><b>${escapeHtml(company)}</b><small>${escapeHtml(contact)}</small></div>
      <span>${job.confidence ? `${job.confidence}%` : "--"}</span>
      <div class="ocr-batch-actions"><button class="btn" type="button" data-ocr-batch-view="${escapeHtml(job.id)}">查看</button>${retryButton}${syncButton}</div>
    </div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-ocr-batch-view]", list).forEach((button) => button.addEventListener("click", () => {
    const job = ocrBatchJobs.find((item) => item.id === button.dataset.ocrBatchView);
    if (!job) return;
    state.ocrJob = job;
    ocrLocalPreviewUrl = "";
    ocrPreviewRevision += 1;
    renderOcr(job);
    qs<HTMLElement>("#ocrPreviewCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  qsa<HTMLButtonElement>("[data-ocr-batch-retry]", list).forEach((button) => button.addEventListener("click", () => void retryOcrBatchJob(button.dataset.ocrBatchRetry || "")));
  qsa<HTMLButtonElement>("[data-ocr-batch-sync]", list).forEach((button) => button.addEventListener("click", () => void syncOcrBatchJob(button.dataset.ocrBatchSync || "")));
}

async function processOcrBatchJob(job: OcrJob, file?: File) {
  const update = (changes: Partial<OcrJob>) => {
    const index = ocrBatchJobs.findIndex((item) => item.id === job.id);
    if (index >= 0) ocrBatchJobs[index] = { ...ocrBatchJobs[index], ...changes };
    renderOcrBatch();
  };
  try {
    if (file) {
      update({ status: "uploading", errorMessage: "" });
      const image = await fileAsDataUrl(file);
      const upload = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(job.id)}/image`, {
        method: "POST",
        body: JSON.stringify({ image, mime: file.type, fileName: file.webkitRelativePath || file.name })
      });
      update({ ...upload.job, status: "processing" });
    } else {
      update({ status: "processing", errorMessage: "" });
    }
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(job.id)}/recognize-image`, { method: "POST", body: "{}" });
    update(result.job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "名片识别失败";
    update({ status: "failed", errorMessage: message });
  }
}

async function retryOcrBatchJob(id: string) {
  const job = ocrBatchJobs.find((item) => item.id === id);
  if (!job || !job.hasImage || ocrBatchRunning) return;
  ocrBatchRunning = true;
  try { await processOcrBatchJob(job); }
  finally { ocrBatchRunning = false; renderOcrBatch(); }
}

async function syncOcrBatchJob(id: string) {
  const job = ocrBatchJobs.find((item) => item.id === id);
  if (!job || job.status !== "recognized") return;
  try {
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(id)}/sync-lead`, { method: "POST" });
    Object.assign(job, result.job);
    await reloadLeads();
    renderOcrBatch();
  } catch (error) { toast(error instanceof Error ? error.message : "同步线索失败", "error"); }
}

async function requestOcrImageRecognition() {
  const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(activeOcrJobId())}/recognize-image`, {
    method: "POST",
    body: "{}"
  });
  state.ocrJob = result.job;
  setOcrHint("识别结果可人工修正，勾选需要同步的字段");
  renderOcr(result.job);
  return result.job;
}

export async function loadOcrCard(file: File) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    toast("只支持 PNG、JPG 或 WebP 名片图片", "error");
    return;
  }
  if (!file.size || file.size > 2 * 1024 * 1024) {
    toast("名片图片大小必须在 2 MB 以内", "error");
    return;
  }
  setOcrBusy(true, "upload");
  setOcrHint("正在安全加载名片图片");
  if (ocrLocalPreviewUrl) URL.revokeObjectURL(ocrLocalPreviewUrl);
  ocrLocalPreviewUrl = URL.createObjectURL(file);
  let uploadCompleted = false;
  try {
    const image = await fileAsDataUrl(file);
    const uploadResult = await api<{ job: OcrJob; message: string }>("/api/tools/ocr/jobs/current/image", {
      method: "POST",
      body: JSON.stringify({ image, mime: file.type, fileName: file.name })
    });
    uploadCompleted = true;
    state.ocrJob = uploadResult.job;
    ocrPreviewRevision += 1;
    renderOcr(uploadResult.job);
    setOcrBusy(true, "recognize");
    setOcrHint("名片已加载，正在调用视觉模型识别");
    await requestOcrImageRecognition();
    toast("名片识别完成", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "名片加载或识别失败";
    if (!uploadCompleted) {
      URL.revokeObjectURL(ocrLocalPreviewUrl);
      ocrLocalPreviewUrl = "";
      if (state.ocrJob) renderOcr(state.ocrJob);
    }
    setOcrHint(`${message}；可人工填写字段后同步`, true);
    toast(message, "error");
  } finally {
    setOcrBusy(false);
    const input = qs<HTMLInputElement>("#ocrFileInput");
    if (input) input.value = "";
  }
}

export async function recognizeOcrImage() {
  if (!state.ocrJob?.hasImage) {
    toast("请先加载一张名片图片", "error");
    return;
  }
  setOcrBusy(true, "recognize");
  setOcrHint("正在重新识别名片");
  try {
    await requestOcrImageRecognition();
    toast("名片重新识别完成", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "名片识别失败";
    setOcrHint(`${message}；可人工填写字段后同步`, true);
    toast(message, "error");
  } finally {
    setOcrBusy(false);
  }
}

export async function removeOcrCard() {
  if (!state.ocrJob?.hasImage || ocrBusy) return;
  setOcrBusy(true, "upload");
  try {
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(activeOcrJobId())}/image`, { method: "DELETE" });
    if (ocrLocalPreviewUrl) URL.revokeObjectURL(ocrLocalPreviewUrl);
    ocrLocalPreviewUrl = "";
    state.ocrJob = result.job;
    setOcrHint("图片将由当前账号配置的视觉模型识别");
    renderOcr(result.job);
    toast("名片已移除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "移除名片失败", "error");
  } finally {
    setOcrBusy(false);
  }
}

export function collectOcrFields() {
  const fields: Record<string, string> = {};
  qsa<HTMLInputElement>("#business-card .field-card input[data-ocr-field]").forEach((checkbox) => {
    if (!checkbox.checked) return;
    const key = checkbox.dataset.ocrField;
    const input = checkbox.parentElement?.querySelector<HTMLInputElement>("input[type='text']");
    if (key && input) fields[key] = input.value;
  });
  return fields;
}

type AiConfigResponse = {
  config: AiModelConfig;
  currentConfig: AiModelConfig | null;
  configs: AiModelConfig[];
};

let aiConfigBusy = false;

export function renderAiConfig(current: AiModelConfig | null) {
  const saved = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  const config = state.aiDraftMode ? null : saved || current || state.aiConfigs[0] || null;
  state.selectedAiConfigId = config?.id || null;
  const list = qs<HTMLElement>("#aiConfigList");
  if (list) {
    list.innerHTML = state.aiConfigs.map((item) => {
      const active = item.id === current?.id;
      const selected = item.id === config?.id;
      return `<button class="ai-instance-row ${selected ? "active" : ""}" type="button" aria-pressed="${selected}" data-ai-config-id="${escapeHtml(item.id)}" ${aiConfigBusy ? "disabled" : ""}>
        <span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.model)}</small></span>
        <em>${active ? badge("当前模型", "green") : ""}${item.hasApiKey ? "" : badge("缺少 Key", "amber")}</em>
      </button>`;
    }).join("") || '<div class="empty-cell">暂无配置</div>';
    qsa<HTMLButtonElement>("[data-ai-config-id]", list).forEach((button) => {
      button.addEventListener("click", () => {
        state.aiDraftMode = false;
        state.pendingAiDeleteId = null;
        state.selectedAiConfigId = button.dataset.aiConfigId || null;
        renderAiConfig(state.aiConfig);
      });
    });
  }

  const deleting = Boolean(config && state.pendingAiDeleteId === config.id);
  const title = qs<HTMLElement>("#aiConfigModeAlert");
  if (title) title.textContent = deleting ? `确认删除「${config?.name}」` : config ? "编辑模型" : "新增模型";
  const toggle = qs<HTMLButtonElement>("#aiToggleEnabledButton");
  if (toggle) toggle.textContent = config && config.id === current?.id ? "停用当前模型" : "设为当前";
  const remove = qs<HTMLButtonElement>("#aiDeleteConfigButton");
  if (remove) remove.textContent = deleting ? "确认删除" : "删除配置";
  setAiConfigButtons();

  if (!state.aiDraftMode) {
    setFieldValue("#gptConfigName", config?.name || "");
    setFieldValue("#gptBaseUrlInput", config?.baseUrl || "");
    setFieldValue("#gptModelInput", config?.model || "");
    setFieldValue("#gptProtocolSelect", config?.protocol || "openai-compatible");
    setFieldValue("#gptTemperatureInput", String(config?.temperature ?? 0.1));
    setFieldValue("#gptBaseUrlSuggestions", "");
    const key = qs<HTMLInputElement>("#gptApiKeyInput");
    if (key) {
      key.value = "";
      key.type = "password";
      key.placeholder = config?.hasApiKey ? "已保存，可留空" : "输入 API Key";
    }
    const reveal = qs<HTMLButtonElement>("#gptRevealKeyButton");
    if (reveal) reveal.textContent = "显示";
    const useFlags = [
      ["#aiUseLeadFinder", config?.useLeadFinder ?? true],
      ["#aiUseScoring", config?.useScoring ?? true],
      ["#aiUseEmailDraft", config?.useEmailDraft ?? true],
      ["#aiUseExam", config?.useExam ?? false]
    ] as const;
    for (const [selector, checked] of useFlags) {
      const input = qs<HTMLInputElement>(selector);
      if (input) input.checked = checked;
    }
  }

  const status = config?.lastTestStatus || "untested";
  const connection = qs<HTMLElement>("#gptConnectionBadge");
  const message = qs<HTMLElement>("#gptConnectionText");
  const webSearch = qs<HTMLElement>("#gptWebSearchStatus");
  if (connection) {
    connection.textContent = status === "passed" ? "连接通过" : status === "failed" ? "连接失败" : "未测试";
    connection.className = `badge ${status === "passed" ? "green" : status === "failed" ? "red" : ""}`;
  }
  if (message) message.textContent = config?.lastTestMessage || "";
  if (webSearch) {
    const webStatus = config?.webSearchStatus;
    webSearch.className = `ai-web-search-status ${webStatus === "passed" ? "is-ready" : webStatus === "failed" ? "is-blocked" : "is-pending"}`;
    webSearch.textContent = ({
      passed: "官网联网测试通过",
      failed: "官网联网测试失败",
      unsupported: "官网发现需配置网页搜索或 Google Places",
      untested: "尚未测试官网联网能力"
    })[webStatus || "untested"];
  }
}

export function bindAiBaseUrlSuggestions() {
  const dropdown = qs<HTMLSelectElement>("#gptBaseUrlSuggestions");
  if (!dropdown) return;
  for (const [id, preset] of Object.entries(aiProviderPresets)) {
    if (id !== "ollama" && id !== "custom") dropdown.add(new Option(`${preset.label} · ${preset.baseUrl}`, id));
  }
  dropdown.addEventListener("change", () => {
    const preset = aiProviderPresets[dropdown.value];
    if (!preset) return;
    setFieldValue("#gptBaseUrlInput", preset.baseUrl);
    setFieldValue("#gptProtocolSelect", preset.protocol);
    dropdown.value = "";
  });
}

export function newAiConfigDraft() {
  if (aiConfigBusy) return;
  state.aiDraftMode = true;
  state.selectedAiConfigId = null;
  state.pendingAiDeleteId = null;
  ["#gptConfigName", "#gptBaseUrlInput", "#gptModelInput", "#gptApiKeyInput", "#gptBaseUrlSuggestions"].forEach((selector) => setFieldValue(selector, ""));
  setFieldValue("#gptProtocolSelect", "openai-compatible");
  setFieldValue("#gptTemperatureInput", "0.1");
  const key = qs<HTMLInputElement>("#gptApiKeyInput");
  if (key) {
    key.type = "password";
    key.placeholder = "输入 API Key";
  }
  const reveal = qs<HTMLButtonElement>("#gptRevealKeyButton");
  if (reveal) reveal.textContent = "显示";
  for (const selector of ["#aiUseLeadFinder", "#aiUseScoring", "#aiUseEmailDraft", "#aiUseExam"]) {
    const input = qs<HTMLInputElement>(selector);
    if (input) input.checked = selector !== "#aiUseExam";
  }
  renderAiConfig(state.aiConfig);
  qs<HTMLInputElement>("#gptConfigName")?.focus();
}

function collectAiConfigPayload(config?: AiModelConfig) {
  const value = (id: string) => qs<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value.trim() || "";
  const checked = (id: string) => Boolean(qs<HTMLInputElement>(`#${id}`)?.checked);
  const baseUrl = value("gptBaseUrlInput");
  const protocol = value("gptProtocolSelect");
  const provider = config?.baseUrl === baseUrl && config.protocol === protocol
    ? config.provider
    : Object.entries(aiProviderPresets).find(([, preset]) => preset.baseUrl === baseUrl.replace(/\/+$/, "") && preset.protocol === protocol)?.[0] || "custom";
  return {
    id: config?.id,
    provider,
    protocol,
    name: value("gptConfigName"),
    baseUrl,
    model: value("gptModelInput"),
    apiKey: value("gptApiKeyInput"),
    temperature: Number(value("gptTemperatureInput") || "0.1"),
    useLeadFinder: checked("aiUseLeadFinder"),
    useWebsiteParse: false,
    useScoring: checked("aiUseScoring"),
    useEmailDraft: checked("aiUseEmailDraft"),
    useExam: checked("aiUseExam")
  };
}

function setAiConfigButtons() {
  qsa<HTMLButtonElement>('#ai-config [data-ai-settings-panel="model"] button:not(#gptRevealKeyButton)').forEach((button) => {
    button.disabled = aiConfigBusy || (
      ["aiToggleEnabledButton", "aiDeleteConfigButton"].includes(button.id) && !state.selectedAiConfigId
    );
  });
}

async function updateAiConfig(button: HTMLButtonElement, progress: string, action: () => Promise<void>) {
  if (aiConfigBusy) return;
  aiConfigBusy = true;
  const label = button.textContent;
  button.textContent = progress;
  setAiConfigButtons();
  try {
    await action();
  } catch (error) {
    toast(error instanceof Error ? error.message : "AI 配置操作失败", "error");
  } finally {
    aiConfigBusy = false;
    if (button.textContent === progress) button.textContent = label;
    setAiConfigButtons();
  }
}

function applyAiConfigResult(configs: AiModelConfig[], current: AiModelConfig | null, selectedId: string | null) {
  state.aiConfig = current;
  state.aiConfigs = configs;
  state.selectedAiConfigId = selectedId;
  state.aiDraftMode = false;
  state.pendingAiDeleteId = null;
  renderAiConfig(current);
}

async function refreshLeadFinderModel() {
  await loadLeadProviders(true);
  renderLeadFinder(state.websiteOpportunities);
  syncLeadFinderStartState();
}

export async function deleteAiConfig(button: HTMLButtonElement) {
  const id = state.selectedAiConfigId;
  if (!id || aiConfigBusy) return;
  if (state.pendingAiDeleteId !== id) {
    state.pendingAiDeleteId = id;
    const config = state.aiConfigs.find((item) => item.id === id);
    const title = qs<HTMLElement>("#aiConfigModeAlert");
    if (title) title.textContent = `确认删除「${config?.name || "模型"}」`;
    button.textContent = "确认删除";
    return;
  }
  await updateAiConfig(button, "删除中…", async () => {
    const result = await api<{ config: AiModelConfig | null; configs: AiModelConfig[] }>(`/api/tools/ai-config/${encodeURIComponent(id)}`, { method: "DELETE" });
    applyAiConfigResult(result.configs, result.config, result.config?.id || null);
    await refreshLeadFinderModel();
    toast("模型配置已删除");
  });
}

export async function toggleAiConfigEnabled(button: HTMLButtonElement) {
  const id = state.selectedAiConfigId;
  if (!id) return;
  const enabled = id !== state.aiConfig?.id;
  await updateAiConfig(button, "保存中…", async () => {
    const result = await api<AiConfigResponse>(`/api/tools/ai-config/${encodeURIComponent(id)}/current`, {
      method: "PUT", body: JSON.stringify({ enabled })
    });
    applyAiConfigResult(result.configs, result.currentConfig, id);
    await refreshLeadFinderModel();
    toast(enabled ? `当前模型已切换为 ${result.config.name}` : "当前模型已停用");
  });
}

export async function saveAiConfig(button: HTMLButtonElement, test = false) {
  const config = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  const payload = collectAiConfigPayload(config);
  if (!payload.name || !payload.baseUrl || !payload.model) {
    toast("请填写配置名称、Base URL 和模型名称", "error");
    return;
  }
  if ((test || config?.enabled) && !payload.apiKey && !config?.hasApiKey) {
    toast("请先填写 API Key", "error");
    return;
  }
  await updateAiConfig(button, test ? "测试中…" : "保存中…", async () => {
    const result = await api<AiConfigResponse>("/api/tools/ai-config", {
      method: "POST", body: JSON.stringify(payload)
    });
    applyAiConfigResult(result.configs, result.currentConfig, result.config.id);
    try {
      if (test) {
        const tested = await api<AiConfigResponse & { ok: boolean; message: string }>("/api/tools/ai-config/test", {
          method: "POST", body: JSON.stringify({ id: result.config.id })
        });
        applyAiConfigResult(tested.configs, tested.currentConfig, tested.config.id);
        toast(tested.message, tested.ok ? "ok" : "error");
      } else {
        toast(`已保存：${result.config.name}`);
      }
    } finally {
      await refreshLeadFinderModel();
    }
  });
}
