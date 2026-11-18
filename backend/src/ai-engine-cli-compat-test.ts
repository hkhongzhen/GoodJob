import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AI_ENGINE_CLAUDE_MODEL_DEFAULT,
  AI_ENGINE_CODEX_MODEL_DEFAULT,
  aiEngineAdapterFallbacks,
  defaultTeamAiEngineSettings,
  engineCliProfile,
  otherAiEngineAdapter,
  sanitizeTeamAiEngineSettings
} from "./ai-engine-settings.js";
import { applyCliProfileToPrompt, chooseEngineRunner, classifyEngineCliIssue } from "./ai-engine-service.js";
import {
  adaptEngineCliPromptForAdapter,
  buildAcquisitionCliPrompt,
  buildTenderDailyCliPrompt
} from "./ai-engine-prompts.js";
import { parseCodexStream, resolveClaudeCliBinary, resolveDirectCliAdapter, runCliSummary } from "./cli-ai.js";
import type { SessionUser } from "./types.js";

// WorkBuddy CLI 与 Codex CLI 兼容（2026-11-05）：团队统一选一个；只配了一个就自动用它；
// Codex 默认模型 gpt-5.6-sol；提示词与故障话术不再带 WorkBuddy 专属写法。

// ---- 1. 设置：Codex 模型单独存，老数据自动补默认
{
  const defaults = defaultTeamAiEngineSettings("t1");
  assert.equal(defaults.codexModel, "gpt-5.6-sol");
  assert.equal(AI_ENGINE_CODEX_MODEL_DEFAULT, "gpt-5.6-sol");
  // 老数据：没有 codexModel / codexEffort 字段
  const legacy = sanitizeTeamAiEngineSettings("t1", { cliAdapter: "codex", cliModel: "deep-model" } as never, defaults);
  assert.equal(legacy.codexModel, "gpt-5.6-sol", "老数据读出时补上 Codex 出厂默认");
  assert.equal(legacy.cliModel, "deep-model");
  const custom = sanitizeTeamAiEngineSettings("t1", { codexModel: "gpt-6.0-preview", codexEffort: "HIGH" } as never, defaults);
  assert.equal(custom.codexModel, "gpt-6.0-preview", "Codex 模型名随版本变化，安全字符内的自定义名可以保存");
  assert.equal(custom.codexEffort, "high");
  const bad = sanitizeTeamAiEngineSettings("t1", { codexModel: "x; rm -rf /", codexEffort: "max" } as never, custom);
  assert.equal(bad.codexModel, "gpt-6.0-preview", "非法模型名回落到上一次的值");
  assert.equal(bad.codexEffort, "high", "Codex 不支持的档位回落");
  assert.equal(sanitizeTeamAiEngineSettings("t1", { codexModel: "" } as never, custom).codexModel, "", "空串 = 跟随本机 Codex 配置");
}

// ---- 2. 模型 / 档位按实际派给的 CLI 取，互不串用
{
  const settings = { ...defaultTeamAiEngineSettings("t1"), cliModel: "deepseek-v4.1-flash", cliEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium" };
  assert.deepEqual(engineCliProfile(settings, "workbuddy"), { model: "deepseek-v4.1-flash", effort: "xhigh" });
  assert.deepEqual(engineCliProfile(settings, "codex"), { model: "gpt-5.6-sol", effort: "medium" });
  assert.equal(otherAiEngineAdapter("codex"), "workbuddy");
  const marked = applyCliProfileToPrompt("正文", engineCliProfile(settings, "codex"));
  assert.ok(marked.startsWith('[[gj-cli-options {"model":"gpt-5.6-sol","effort":"medium"}]]'), "Codex 任务也带执行档位标记（Runner 会翻译成 -m / reasoning effort）");
}

// ---- 3. 选机器 + 选 CLI：首选不可用时自动改用另一个
{
  const actor = { id: "u1", teamId: "t1" } as SessionUser;
  const runner = (id: string, capabilities: string[], online = true) => ({
    id, ownerId: "u1", displayName: id, online, capabilities, workspaces: ["/work"],
    workbuddyVersion: capabilities.includes("workbuddy") ? "wb 1.0" : "", codexVersion: capabilities.includes("codex") ? "codex 1.0" : "", lastError: ""
  });
  const base = defaultTeamAiEngineSettings("t1");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy", "codex"])], actor, { ...base, cliAdapter: "codex" }).adapter, "codex", "两个都配了：按团队选择");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy", "codex"])], actor, { ...base, cliAdapter: "workbuddy" }).adapter, "workbuddy");
  const onlyWb = chooseEngineRunner([runner("r1", ["workbuddy"])], actor, { ...base, cliAdapter: "codex" });
  assert.equal(onlyWb.adapter, "workbuddy", "只配了 WorkBuddy：选了 Codex 也自动用 WorkBuddy");
  assert.equal(onlyWb.cliVersion, "wb 1.0");
  assert.equal(chooseEngineRunner([runner("r1", ["codex"])], actor, { ...base, cliAdapter: "workbuddy" }).adapter, "codex", "只配了 Codex：自动用 Codex");
  // 首选 CLI 在另一台机器上：优先换机器保持首选，而不是在第一台上改用另一个 CLI
  const prefersMachine = chooseEngineRunner([runner("r1", ["workbuddy"]), runner("r2", ["codex"])], actor, { ...base, cliAdapter: "codex" });
  assert.deepEqual([prefersMachine.runnerId, prefersMachine.adapter], ["r2", "codex"]);
  // 指定 Runner：只在那台上找，那台只有另一个 CLI 就用另一个
  const pinned = chooseEngineRunner([runner("r1", ["workbuddy"]), runner("r2", ["codex"])], actor, { ...base, cliAdapter: "codex", runnerId: "r1" });
  assert.deepEqual([pinned.runnerId, pinned.adapter], ["r1", "workbuddy"], "指定的 Runner 不静默换机器");
  assert.throws(() => chooseEngineRunner([runner("r1", [])], actor, base), (error: unknown) => (error as { code?: string }).code === "AI_ENGINE_CLI_MISSING");
  assert.throws(() => chooseEngineRunner([runner("r1", ["codex"], false)], actor, base), (error: unknown) => (error as { code?: string }).code === "AI_ENGINE_RUNNER_MISSING");
}

// ---- 4. 提示词：Codex 版不再要求 Skill 工具 / WebFetch，改为读取同一份技能包文件
{
  const tender = buildTenderDailyCliPrompt({ reportDate: "2026-11-05", companyName: "GoodJob", productSummary: "water pumps", regions: "Asia", focusNote: "" });
  assert.equal(adaptEngineCliPromptForAdapter(tender, "workbuddy"), tender, "WorkBuddy 提示词原样不变");
  const codexTender = adaptEngineCliPromptForAdapter(tender, "codex");
  assert.ok(!/Skill tool|WebFetch/u.test(codexTender), "Codex 版不含 WorkBuddy 专属工具名");
  assert.ok(codexTender.includes(".workbuddy/skills/goodjob-tender-daily/SKILL.md"));
  assert.ok(codexTender.includes("read-only sandbox"));
  const acquisition = adaptEngineCliPromptForAdapter(buildAcquisitionCliPrompt({ goal: "pump distributors", productKeywords: "", countries: "", industry: "", customerType: "", excludeKeywords: "", limit: 5 }), "codex");
  assert.ok(acquisition.includes(".workbuddy/skills/goodjob-lead-acquisition/SKILL.md") && !acquisition.includes("Skill tool"));
}

// ---- 5. 故障话术按 CLI 区分
{
  assert.match(classifyEngineCliIssue("Authentication required", "codex").command, /codex login/u);
  assert.doesNotMatch(classifyEngineCliIssue("Authentication required", "codex").command, /codebuddy/u);
  assert.match(classifyEngineCliIssue("Authentication required").command, /codebuddy/u, "默认（WorkBuddy）话术不变");
  assert.equal(classifyEngineCliIssue("model gpt-x not supported", "codex").title, "Codex CLI 不认识所选模型");
}

// ---- 6. 后端直连通道：Codex 事件流解析、CLI 自动选择、真实子进程调用
{
  const parsed = parseCodexStream([
    JSON.stringify({ type: "thread.started", thread_id: "th1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "草稿一" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "最终答案" } }),
    JSON.stringify({ type: "turn.completed" })
  ]);
  assert.deepEqual([parsed.text, parsed.failed], ["最终答案", false]);
  const failedStream = parseCodexStream([JSON.stringify({ type: "turn.failed", error: { message: "model not found" } })]);
  assert.deepEqual([failedStream.failed, failedStream.error], [true, "model not found"]);

  assert.equal(resolveDirectCliAdapter("codex", (adapter) => adapter === "workbuddy"), "workbuddy", "首选没装就用另一个");
  assert.equal(resolveDirectCliAdapter("workbuddy", (adapter) => adapter === "codex"), "codex");
  assert.equal(resolveDirectCliAdapter("codex", () => true), "codex");
  assert.equal(resolveDirectCliAdapter("codex", () => false), "codex", "都没装按首选，随后如实报错");

  const dir = mkdtempSync(path.join(tmpdir(), "fake-codex-"));
  const invocation = path.join(dir, "invocation.json");
  const fake = path.join(dir, "codex");
  writeFileSync(fake, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  if (prompt.includes("FAIL")) { console.log(JSON.stringify({ type: "turn.failed", error: { message: "Authentication required" } })); return; }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "th" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\\"ok\\":true}" } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
});
`);
  chmodSync(fake, 0o755);
  const result = await runCliSummary("总结一下", { adapter: "codex", binary: fake, timeoutMs: 15_000 });
  assert.equal(result.text, '{"ok":true}');
  const call = JSON.parse(readFileSync(invocation, "utf8")) as { argv: string[]; prompt: string };
  assert.equal(call.prompt, "总结一下", "提示词走 stdin");
  const execAt = call.argv.indexOf("exec");
  assert.ok(execAt >= 0 && call.argv.includes("--json") && call.argv.at(-1) === "-");
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--sandbox"), call.argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"], "直连 Codex 只读执行");
  assert.ok(call.argv.indexOf('model_reasoning_effort="low"') < execAt, "总结类任务默认 low 档位");
  await assert.rejects(runCliSummary("FAIL", { adapter: "codex", binary: fake, timeoutMs: 15_000 }), /Authentication required/u);
  await assert.rejects(runCliSummary("x", { adapter: "codex", binary: path.join(dir, "missing-codex"), timeoutMs: 15_000 }), /Codex CLI 不存在/u);
}


// ---- 7. Claude Code CLI（2026-11-13）：第三个 CLI，订阅登录、不需要 API Key
{
  // 设置：模型 / 档位单独存；老数据自动补默认；非法值回落
  const defaults = defaultTeamAiEngineSettings("t1");
  assert.equal(defaults.claudeModel, AI_ENGINE_CLAUDE_MODEL_DEFAULT);
  assert.equal(AI_ENGINE_CLAUDE_MODEL_DEFAULT, "sonnet");
  const legacy = sanitizeTeamAiEngineSettings("t1", { cliAdapter: "claude" } as never, { ...defaults, claudeModel: undefined, claudeEffort: undefined } as never);
  assert.equal(legacy.cliAdapter, "claude", "cliAdapter 接受 claude");
  assert.equal(legacy.claudeModel, "sonnet", "老数据读出时补上 Claude 出厂默认");
  const custom = sanitizeTeamAiEngineSettings("t1", { claudeModel: "claude-opus-5-5", claudeEffort: "XHIGH" } as never, defaults);
  assert.equal(custom.claudeModel, "claude-opus-5-5", "完整模型 ID 可以保存");
  assert.equal(custom.claudeEffort, "xhigh");
  assert.equal(sanitizeTeamAiEngineSettings("t1", { claudeModel: "opus[1m]" } as never, defaults).claudeModel, "opus[1m]");
  const bad = sanitizeTeamAiEngineSettings("t1", { claudeModel: "x; rm -rf /", claudeEffort: "minimal" } as never, custom);
  assert.equal(bad.claudeModel, "claude-opus-5-5", "非法模型名回落到上一次的值");
  assert.equal(bad.claudeEffort, "xhigh", "Claude 没有 minimal 档，回落");
  assert.equal(sanitizeTeamAiEngineSettings("t1", { claudeModel: "" } as never, custom).claudeModel, "", "空串 = 跟随当前登录账号默认");
  assert.equal(sanitizeTeamAiEngineSettings("t1", { cliAdapter: "bogus" } as never, defaults).cliAdapter, "workbuddy", "未知适配器回落");

  // 模型 / 档位互不串用
  const settings = { ...defaults, cliModel: "deepseek-v4.1-flash", cliEffort: "high", codexModel: "gpt-5.6-sol", codexEffort: "medium", claudeModel: "opus", claudeEffort: "max" };
  assert.deepEqual(engineCliProfile(settings, "claude"), { model: "opus", effort: "max" });
  assert.deepEqual(engineCliProfile(settings, "workbuddy"), { model: "deepseek-v4.1-flash", effort: "high" }, "WorkBuddy 不受影响");
  assert.deepEqual(engineCliProfile(settings, "codex"), { model: "gpt-5.6-sol", effort: "medium" }, "Codex 不受影响");

  // 回退顺序：既有的 WorkBuddy ↔ Codex 互备保持不变，Claude 排最后
  assert.deepEqual(aiEngineAdapterFallbacks("workbuddy"), ["codex", "claude"]);
  assert.deepEqual(aiEngineAdapterFallbacks("codex"), ["workbuddy", "claude"]);
  assert.deepEqual(aiEngineAdapterFallbacks("claude"), ["workbuddy", "codex"]);
  assert.equal(otherAiEngineAdapter("codex"), "workbuddy");
  assert.equal(otherAiEngineAdapter("workbuddy"), "codex");

  // 选机器 + 选 CLI
  const actor = { id: "u1", teamId: "t1" } as SessionUser;
  const runner = (id: string, capabilities: string[], online = true) => ({
    id, ownerId: "u1", displayName: id, online, capabilities, workspaces: ["/work"],
    workbuddyVersion: capabilities.includes("workbuddy") ? "wb 1.0" : "",
    codexVersion: capabilities.includes("codex") ? "codex 1.0" : "",
    claudeVersion: capabilities.includes("claude") ? "2.1.322 (Claude Code)" : "",
    lastError: ""
  });
  const claudePref = { ...defaults, cliAdapter: "claude" as const };
  const picked = chooseEngineRunner([runner("r1", ["workbuddy", "codex", "claude"])], actor, claudePref);
  assert.equal(picked.adapter, "claude", "三个都装了：按团队选择");
  assert.equal(picked.cliVersion, "2.1.322 (Claude Code)", "版本取自 Claude 自己的字段");
  assert.equal(chooseEngineRunner([runner("r1", ["claude"])], actor, { ...defaults, cliAdapter: "workbuddy" }).adapter, "claude", "只装了 Claude：选别的也自动用它");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy", "claude"])], actor, { ...defaults, cliAdapter: "codex" }).adapter, "workbuddy", "老互备关系优先于 Claude");
  assert.equal(chooseEngineRunner([runner("r1", ["codex", "claude"])], actor, claudePref).adapter, "claude", "首选 Claude 可用就用它");
  assert.equal(chooseEngineRunner([runner("r1", ["codex"])], actor, claudePref).adapter, "codex", "首选 Claude 不可用、只有 Codex：用 Codex");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy", "codex"])], actor, claudePref).adapter, "workbuddy", "首选 Claude 不可用：先 WorkBuddy 再 Codex");
  const pinnedClaude = chooseEngineRunner([runner("r1", ["claude"]), runner("r2", ["workbuddy"])], actor, { ...defaults, cliAdapter: "workbuddy", runnerId: "r1" });
  assert.deepEqual([pinnedClaude.runnerId, pinnedClaude.adapter], ["r1", "claude"], "指定的 Runner 上只有 Claude 就用 Claude，不静默换机器");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy"]), runner("r2", ["claude"])], actor, claudePref).runnerId, "r2", "优先换机器保持首选");

  // 提示词：技能指令改读文件（--safe-mode 关掉了 Skill 工具）；联网语境保持与 WorkBuddy 一致
  const tender = buildTenderDailyCliPrompt({ reportDate: "2026-11-13", companyName: "GoodJob", productSummary: "water pumps", regions: "Asia", focusNote: "" });
  const claudeTender = adaptEngineCliPromptForAdapter(tender, "claude");
  assert.ok(!/using the Skill tool/u.test(claudeTender), "Claude 版不再要求 Skill 工具");
  assert.ok(claudeTender.includes(".workbuddy/skills/goodjob-tender-daily/SKILL.md"));
  assert.ok(!claudeTender.includes("read-only sandbox"), "Codex 沙箱专属改写不得套到 Claude 上");
  assert.ok(claudeTender.includes("WebFetch, Bash/curl"), "Claude 有 WebFetch，保留原联网语境");
  assert.equal(adaptEngineCliPromptForAdapter(tender, "workbuddy"), tender, "WorkBuddy 提示词仍原样不变");
  // 获客提示词：只有 Claude 追加「别早放弃」的尽力要求（实测它 20 秒就交空列表）；其它 CLI 与非获客提示词不变
  const acquisitionBase = buildAcquisitionCliPrompt({ goal: "pump distributors", productKeywords: "", countries: "", industry: "", customerType: "", excludeKeywords: "", limit: 5 });
  assert.ok(adaptEngineCliPromptForAdapter(acquisitionBase, "claude").includes("Effort requirement"), "Claude 获客提示词要带尽力要求");
  assert.ok(adaptEngineCliPromptForAdapter(acquisitionBase, "claude").includes("at least 10 different web searches"));
  assert.ok(adaptEngineCliPromptForAdapter(acquisitionBase, "claude").includes('subagent_type "web-fetch"'), "Claude 版必须说明用 web-fetch 子代理读网页（主会话没有 WebFetch 时的唯一读页途径）");
  assert.ok(!adaptEngineCliPromptForAdapter(acquisitionBase, "claude").includes("do NOT delegate to sub-agents"), "不得再禁止子代理：读网页只能靠它");
  assert.ok(!adaptEngineCliPromptForAdapter(acquisitionBase, "codex").includes("Effort requirement"), "Codex 不受影响");
  assert.equal(adaptEngineCliPromptForAdapter(acquisitionBase, "workbuddy"), acquisitionBase, "WorkBuddy 原样不变");
  assert.ok(!adaptEngineCliPromptForAdapter(tender, "claude").includes("Effort requirement"), "非获客提示词不受影响");

  // 故障话术：登录用 claude /login；联网要「确认代理可用」而不是「关掉代理」
  const auth = classifyEngineCliIssue("Authentication required", "claude");
  assert.equal(auth.code, "cli_auth_required");
  assert.match(auth.command, /claude/u);
  assert.match(auth.command, /\/login/u);
  assert.doesNotMatch(auth.command, /codebuddy|codex login/u);
  assert.match(classifyEngineCliIssue("fetch failed ECONNREFUSED", "claude").command, /代理/u);
  assert.doesNotMatch(classifyEngineCliIssue("fetch failed ECONNREFUSED", "claude").command, /关掉/u);
  assert.equal(classifyEngineCliIssue("rate limit exceeded 429", "claude").title, "Claude 订阅额度暂时用完");
  assert.equal(classifyEngineCliIssue("model foo not found", "claude").title, "Claude Code CLI 不认识所选模型");
  assert.match(classifyEngineCliIssue("boom", "claude").title, /Claude Code CLI/u);

  // 后端直连：真实子进程（假的 claude），检查参数、stdin、环境
  assert.equal(resolveDirectCliAdapter("claude", (adapter) => adapter === "workbuddy"), "workbuddy", "Claude 没装就先用 WorkBuddy");
  assert.equal(resolveDirectCliAdapter("claude", (adapter) => adapter === "codex"), "codex");
  assert.equal(resolveDirectCliAdapter("workbuddy", (adapter) => adapter === "claude"), "claude", "只装了 Claude 也能用上");
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const invocation = path.join(dir, "invocation.json");
  const fake = path.join(dir, "claude");
  writeFileSync(fake, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ argv: process.argv.slice(2), prompt, claudecode: process.env.CLAUDECODE || "", proxy: process.env.HTTPS_PROXY || "" }));
  console.log(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }));
  if (prompt.includes("FAIL")) { console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Authentication required"] })); return; }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "草稿" }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\\"ok\\":true}" }));
});
`);
  chmodSync(fake, 0o755);
  const savedEnv = { CLAUDECODE: process.env.CLAUDECODE, HTTPS_PROXY: process.env.HTTPS_PROXY };
  process.env.CLAUDECODE = "1";
  process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
  let call: { argv: string[]; prompt: string; claudecode: string; proxy: string };
  let result;
  try {
    result = await runCliSummary("总结一下", { adapter: "claude", binary: fake, timeoutMs: 15_000 });
    call = JSON.parse(readFileSync(invocation, "utf8"));
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.model, "claude-sonnet-5-5", "用 CLI 自报的实际模型");
  assert.equal(call.prompt, "总结一下", "提示词走 stdin");
  for (const flag of ["--print", "--verbose", "--safe-mode", "--no-session-persistence"]) assert.ok(call.argv.includes(flag), `缺少 ${flag}`);
  assert.equal(call.argv[call.argv.indexOf("--output-format") + 1], "stream-json");
  assert.equal(call.argv[call.argv.indexOf("--permission-mode") + 1], "plan", "总结任务只读");
  assert.equal(call.argv[call.argv.indexOf("--max-turns") + 1], "2");
  assert.ok(call.argv[call.argv.indexOf("--disallowedTools") + 1].split(",").includes("Write"), "禁写工具");
  assert.equal(call.argv[call.argv.indexOf("--effort") + 1], "low", "总结类任务默认 low 档位");
  assert.equal(call.claudecode, "", "宿主 Claude Code 会话变量不得泄漏给子进程");
  assert.equal(call.proxy, "http://127.0.0.1:7890", "代理必须保留：Claude 出网常依赖它");
  await runCliSummary("x", { adapter: "claude", binary: fake, timeoutMs: 15_000 });
  await assert.rejects(runCliSummary("FAIL", { adapter: "claude", binary: fake, timeoutMs: 15_000 }), /Authentication required/u);
  // 「没装」：PATH 与 HOME 指向空目录（解析器会回退到 PATH / ~/.local/bin 等位置，不能依赖本机恰好没装）
  const emptyDir = mkdtempSync(path.join(tmpdir(), "no-claude-"));
  const savedLocation = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = emptyDir;
  process.env.HOME = emptyDir;
  try {
    if (resolveClaudeCliBinary() === "claude") {
      await assert.rejects(runCliSummary("x", { adapter: "claude", timeoutMs: 15_000 }), /Claude Code CLI 不存在/u);
    }
  } finally {
    process.env.PATH = savedLocation.PATH;
    process.env.HOME = savedLocation.HOME;
  }
}

console.log(JSON.stringify({ ok: true, checked: "ai-engine-cli-compat" }, null, 2));
