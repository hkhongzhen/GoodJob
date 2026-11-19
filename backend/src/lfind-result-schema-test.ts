import assert from "node:assert/strict";
import { lfindResultSchema } from "./routes/lead-finder.js";

// summary 是对象：原样通过。
const asObject = lfindResultSchema.parse({ summary: { target: "powder coating", accepted: 3 }, opportunities: [] });
assert.equal(asObject.summary.target, "powder coating");
assert.equal(asObject.summary.accepted, 3);

// CLI 把 summary 写成一句话：不能让整份结果作废，文字按本次目标收下。
const asText = lfindResultSchema.parse({
  summary: "找到 16 家有自有粉末喷涂线的美国工厂",
  opportunities: [{ company: "Acme Coating", website: "https://acme.example.test" }]
});
assert.equal(asText.summary.target, "找到 16 家有自有粉末喷涂线的美国工厂");
assert.equal(asText.summary.accepted, 0);
assert.equal(asText.opportunities.length, 1);

// 缺省 summary 仍然可用；其他类型仍应报错（不放过真正的乱格式）。
assert.deepEqual(lfindResultSchema.parse({ opportunities: [] }).summary.markets, []);
assert.throws(() => lfindResultSchema.parse({ summary: 42, opportunities: [] }));

console.log("Lfind result schema tests passed");
