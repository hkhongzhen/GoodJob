import assert from "node:assert/strict";
import { outboundBounceGuardSettings, outboundBounceStats, setOutboundBounceGuardRuntime } from "./server-core.js";

const now = Date.parse("2026-11-22T12:00:00Z");
const day = 86_400_000;
const logs = (sent: number, bounced: number, ageDays = 1) =>
  Array.from({ length: sent }, (_, index) => ({
    sentAt: new Date(now - ageDays * day).toISOString(),
    bouncedAt: index < bounced ? new Date(now - ageDays * day + 1000).toISOString() : undefined
  }));

// 默认（env 兜底）：开启、10%、7 天、20 封
setOutboundBounceGuardRuntime("");
assert.deepEqual(
  { ...outboundBounceGuardSettings(), source: undefined },
  { enabled: true, maxBouncePercent: 10, windowDays: 7, minSample: 20, source: undefined }
);
assert.equal(outboundBounceStats(logs(26, 3), now).triggered, true, "26 封 3 退 = 11.5% 应触发");
assert.equal(outboundBounceStats(logs(19, 3), now).triggered, false, "样本不足 20 封不判定");

// 调高阈值：11.5% < 15% 放行
setOutboundBounceGuardRuntime(JSON.stringify({ enabled: true, maxBouncePercent: 15, windowDays: 7, minSample: 20 }));
assert.equal(outboundBounceStats(logs(26, 3), now).triggered, false);
assert.equal(outboundBounceGuardSettings().source, "app_settings");

// 关闭：再高的退信率也放行，但统计照常给出
setOutboundBounceGuardRuntime(JSON.stringify({ enabled: false, maxBouncePercent: 10, windowDays: 7, minSample: 1 }));
const off = outboundBounceStats(logs(10, 9), now);
assert.equal(off.triggered, false);
assert.equal(off.bounced, 9);

// 窗口外的退信不计入
setOutboundBounceGuardRuntime(JSON.stringify({ enabled: true, maxBouncePercent: 10, windowDays: 3, minSample: 1 }));
assert.equal(outboundBounceStats([...logs(5, 5, 10), ...logs(5, 0, 1)], now).triggered, false);

// 坏数据回落 env
setOutboundBounceGuardRuntime("{not json");
assert.equal(outboundBounceGuardSettings().source, "env");

setOutboundBounceGuardRuntime("");
console.log("Outbound bounce guard tests passed");
process.exit(0);
