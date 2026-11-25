import { randomUUID } from "node:crypto";
import { currentAiModelConfig } from "./ai-model-selection.js";
import { callAiModel } from "./ai-model-runtime.js";
import type { AgentActor, AgentPlanContext, AgentRun } from "./ai-agent.js";
import { GJAB_VERSION, runGjabPlanBenchmark } from "./agent-benchmark.js";
import { runAgentIntentCorpusBenchmark } from "./agent-intent-corpus.js";
import type { CrmStore } from "./store.js";
import type { AgentEvaluationRunRecord, AgentModelCallPurpose, AiModelConfig } from "./types.js";

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimatedTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 3.2));
}

function estimatedCost(inputTokens: number, outputTokens: number) {
  const inputRate = positiveNumber(process.env.AGENT_INPUT_USD_PER_MILLION_TOKENS, 0.5);
  const outputRate = positiveNumber(process.env.AGENT_OUTPUT_USD_PER_MILLION_TOKENS, 1.5);
  return Number(((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000).toFixed(6));
}

function budgetUsage(store: CrmStore, actor: AgentActor, runId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const visible = store.agentModelCalls.filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId && item.success);
  return {
    daily: visible.filter((item) => item.createdAt.startsWith(today)).reduce((sum, item) => sum + item.estimatedCostUsd, 0),
    mission: visible.filter((item) => item.runId === runId).reduce((sum, item) => sum + item.estimatedCostUsd, 0)
  };
}

export async function callGovernedAgentModel(input: {
  store: CrmStore;
  actor: AgentActor;
  runId: string;
  purpose: AgentModelCallPurpose;
  preferred: AiModelConfig;
  prompt: string;
  maxInputChars: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<globalThis.Response>;
}) {
  const dailyBudget = positiveNumber(process.env.AGENT_DAILY_BUDGET_USD, 10);
  const missionBudget = positiveNumber(process.env.AGENT_MISSION_BUDGET_USD, 2);
  const usage = budgetUsage(input.store, input.actor, input.runId);
  if (usage.daily >= dailyBudget) throw new Error("Agent 今日模型预算已用尽");
  if (usage.mission >= missionBudget) throw new Error("当前 Mission 模型预算已用尽");
  const config = currentAiModelConfig(input.store, input.actor.id, input.actor.teamId);
  if (!config) throw new Error("没有可用的 Agent 模型");
  if (config.id !== input.preferred.id) throw new Error("当前模型已变更，请重试");
  const startedAt = Date.now();
  const inputTokens = estimatedTokens(input.prompt.slice(0, input.maxInputChars));
  const call = {
    id: `agmc_${randomUUID()}`, runId: input.runId, ownerId: input.actor.id, teamId: input.actor.teamId,
    purpose: input.purpose, configId: config.id, provider: config.provider, model: config.model,
    routeIndex: 0, inputTokens, createdAt: new Date().toISOString()
  };
  let content: string;
  try {
    content = await callAiModel(config, input.prompt, input.maxInputChars, input.fetcher);
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型调用失败";
    input.store.agentModelCalls.unshift({
      ...call, success: false, outputTokens: 0, estimatedCostUsd: 0,
      latencyMs: Date.now() - startedAt, error: message.slice(0, 500)
    });
    await input.store.persist();
    throw error;
  }
  const outputTokens = estimatedTokens(content);
  input.store.agentModelCalls.unshift({
    ...call, success: true, outputTokens, estimatedCostUsd: estimatedCost(inputTokens, outputTokens),
    latencyMs: Date.now() - startedAt, error: ""
  });
  await input.store.persist();
  return content;
}

export function agentModelMetrics(store: CrmStore, actor: AgentActor) {
  const calls = store.agentModelCalls.filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId);
  const dayBoundary = Date.now() - 86_400_000;
  const recent = calls.filter((item) => new Date(item.createdAt).getTime() >= dayBoundary);
  const success = recent.filter((item) => item.success);
  const totalTokens = success.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0);
  const estimatedCostUsd = success.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  return {
    last24Hours: { calls: recent.length, successes: success.length, failures: recent.length - success.length, fallbackCalls: recent.filter((item) => item.routeIndex > 0).length, successRate: recent.length ? Math.round(success.length / recent.length * 100) : 0, averageLatencyMs: success.length ? Math.round(success.reduce((sum, item) => sum + item.latencyMs, 0) / success.length) : 0, totalTokens, estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)) },
    budgets: { dailyUsd: positiveNumber(process.env.AGENT_DAILY_BUDGET_USD, 10), missionUsd: positiveNumber(process.env.AGENT_MISSION_BUDGET_USD, 2) },
    routes: { planning: "当前模型", evaluation: "当前模型", fallbackEnabled: false },
    recentCalls: recent.slice(0, 30),
    evaluations: store.agentEvaluationRuns.filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId).slice(0, 10)
  };
}

export async function runAgentEvaluationSuite(store: CrmStore, actor: AgentActor, planner: (goal: string, context: AgentPlanContext) => Promise<AgentRun>) {
  const intentCorpus = runAgentIntentCorpusBenchmark();
  const benchmark = await runGjabPlanBenchmark(store, actor, planner);
  const results: AgentEvaluationRunRecord["results"] = [{
    id: "intent-corpus-v1",
    name: `真实表达意图语料（${intentCorpus.total} 条）`,
    passed: intentCorpus.failures.length === 0,
    detail: intentCorpus.failures.length
      ? `${intentCorpus.passed}/${intentCorpus.total}；${intentCorpus.failures.slice(0, 3).map((item) => `${item.phrase} -> ${item.actual}`).join("；")}`
      : `${intentCorpus.passed}/${intentCorpus.total} 全部通过`
  }, ...benchmark.results];
  const temporaryRuns = benchmark.temporaryRuns;
  const ids = new Set(temporaryRuns);
  store.agentRuns = store.agentRuns.filter((item) => !ids.has(item.id));
  store.agentRunSteps = store.agentRunSteps.filter((item) => !ids.has(item.runId));
  store.agentRunEvents = store.agentRunEvents.filter((item) => !ids.has(item.runId));
  store.agentMissionCheckpoints = store.agentMissionCheckpoints.filter((item) => !ids.has(item.runId));
  const record: AgentEvaluationRunRecord = { id: `agev_${randomUUID()}`, ownerId: actor.id, teamId: actor.teamId, version: GJAB_VERSION, passed: results.filter((item) => item.passed).length, total: results.length, results, createdAt: new Date().toISOString() };
  store.agentEvaluationRuns.unshift(record);
  await store.persist();
  return record;
}
