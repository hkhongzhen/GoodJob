import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseWorkbuddyCliProfile,
  runStreamJsonCliTask,
  type WorkBuddyExecutionOptions,
  type WorkBuddyExecutionResult
} from "./workbuddy-adapter.js";
import type { ClaimedTask } from "./types.js";

/**
 * Claude Code CLI 适配器（订阅登录，不需要 API Key）。
 *
 * 与 WorkBuddy（CodeBuddy Code）同属 `--print --output-format stream-json` 系 CLI，事件格式一致
 * （system / assistant / result），所以复用 runStreamJsonCliTask；差异只在下面几处：
 *  - 二进制与登录：`claude`，凭据由 `claude login` 写入用户目录，Runner 不接触；
 *  - `--verbose`：Claude Code 在 `--print` 下输出 stream-json 时必须带它，否则直接报错；
 *  - `--safe-mode`：关闭 CLAUDE.md、用户技能、hooks、MCP、插件等一切自定义，
 *    让任务只依赖提示词本身——否则本机个人配置里的 hook 会在 CRM 任务里被执行；
 *  - 模型：别名（opus / sonnet / haiku）或完整模型 ID，不是 WorkBuddy 的那套白名单；
 *  - 环境：只剔除「宿主 Claude Code 会话」注入的变量，**不**剔除代理。
 *    WorkBuddy 的云端在国内，需要直连所以强制 NO_PROXY；Claude 走 Anthropic 官方域名，
 *    很多网络必须经本机代理才能出网，剔掉会导致任务全部连不上。
 */

/** Claude Code 常见安装位置（Runner 常由 launchd / 受限 PATH 启动，PATH 里不一定有它） */
function claudeBinaryCandidates() {
  const home = homedir();
  return [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".npm-global", "bin", "claude"),
    join(home, ".bun", "bin", "claude")
  ];
}

/**
 * 解析 Claude Code 可执行文件：
 * 1) GOODJOB_CLAUDE_BIN 显式指定；
 * 2) PATH 里的 claude；
 * 3) 常见安装位置；
 * 4) 回退到裸名字（未安装时版本探测返回空，能力自动关闭）。
 */
export function resolveClaudeBinary(configured = process.env.GOODJOB_CLAUDE_BIN || "") {
  if (configured) return configured;
  try {
    const fromPath = execFileSync("which", ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fromPath && existsSync(fromPath)) return fromPath;
  } catch {
    // PATH 里没有 claude，继续找常见位置
  }
  return claudeBinaryCandidates().find((candidate) => existsSync(candidate)) || "claude";
}

/** 必须从子进程剔除的变量：宿主 Claude Code 会话 / 追踪 / 进程形态标记 */
const STRIPPED_ENVIRONMENT_KEYS = [
  "NODE_OPTIONS",
  "BASH_ENV",
  "TRACEPARENT",
  "BAGGAGE",
  "ELECTRON_RUN_AS_NODE",
  "CLAUDECODE",
  "CLAUDE_SESSION_ID"
];

/**
 * `CLAUDE_CODE_*` 整族都是「宿主会话」变量（入口、IDE 端口、会话 ID、可执行路径……），
 * 带着它们会让 CLI 以为自己是宿主的子会话。但下面这些是**登录 / 供应商选择**，必须保留，
 * 否则用 OAuth Token、Bedrock、Vertex 的用户会被误判成未登录。
 */
const KEPT_CLAUDE_CODE_KEYS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS"
]);

export function claudeProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of STRIPPED_ENVIRONMENT_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") && !KEPT_CLAUDE_CODE_KEYS.has(key)) delete env[key];
  }
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

/** Claude 的模型：别名（opus / sonnet / haiku）或完整模型 ID（可带 [1m] 之类后缀）。只接受安全字符。 */
const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/u;
/** Claude Code 支持的思考档位；CRM 里更低的 minimal 在这里按 low 执行 */
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function claudeModelAllowed(model: string) {
  return CLAUDE_MODEL_PATTERN.test(model);
}

/** 解析提示词首行的档位标记，并把 Claude 不支持的档位收敛到支持集合内 */
export function parseClaudeCliProfile(prompt: string) {
  const parsed = parseWorkbuddyCliProfile(prompt, claudeModelAllowed);
  const effort = parsed.profile.effort === "minimal" ? "low" : parsed.profile.effort;
  return {
    prompt: parsed.prompt,
    profile: { ...parsed.profile, effort: CLAUDE_EFFORTS.has(effort) ? effort : "" }
  };
}

/**
 * 权限：用 `dontAsk` + 显式白名单，而不是 `plan`。
 *
 * 2026-11-13 实测教训：`plan` 在 Claude Code 里是「只做计划、不许执行」的模式——复杂提示词下
 * 模型会直接回答「plan mode 禁止执行任务」而一次搜索都不跑（获客任务因此交了空结果）。
 * `dontAsk` 的语义是「没预先放行的工具一律拒绝、不弹确认」，配合白名单正好等价于只读：
 *   - 放行：WebSearch / WebFetch / Read / Glob / Grep（联网调研与读资料）；
 *   - 剔除：Write / Edit / NotebookEdit / Bash（实测被禁的工具不会出现在会话里，文件写不出来）。
 * 可写任务才用 acceptEdits，并额外放行 Write / Edit；Bash 两种模式都不放（不给任意 Shell）。
 * 任务提示词标记里点名禁用的工具（如 WebFetch）会合并进禁用列表，且从放行列表里剔掉。
 */
const CLAUDE_READ_TOOLS = ["WebSearch", "WebFetch", "Read", "Glob", "Grep"];

export function claudePermissionArgs(mode: "read_only" | "workspace_write", profile: { disallowedTools: string[] }) {
  const writable = mode === "workspace_write";
  const disallowed = [...new Set([
    ...(writable ? [] : ["Write", "Edit", "NotebookEdit"]),
    "Bash",
    ...profile.disallowedTools
  ])];
  const allowed = [...CLAUDE_READ_TOOLS, ...(writable ? ["Write", "Edit"] : [])].filter((tool) => !disallowed.includes(tool));
  return [
    "--permission-mode", writable ? "acceptEdits" : "dontAsk",
    "--allowedTools", allowed.join(","),
    "--disallowedTools", disallowed.join(",")
  ];
}

export interface ClaudeExecutionOptions extends WorkBuddyExecutionOptions {
  claudeBinary?: string;
}

export async function executeClaudeTask(task: ClaimedTask, options: ClaudeExecutionOptions): Promise<WorkBuddyExecutionResult> {
  if (task.adapter !== "claude") throw new Error("Runner 只允许执行 Claude Code 适配器任务");
  return runStreamJsonCliTask(task, options, {
    label: "Claude Code CLI",
    binary: options.claudeBinary || resolveClaudeBinary(),
    parseProfile: parseClaudeCliProfile,
    extraArgs: ["--verbose", "--safe-mode"],
    environment: () => claudeProcessEnvironment(),
    permissionArgs: claudePermissionArgs
  });
}
