/**
 * 归一化「公司名 + 国家」重复判定键：去首尾空格、压平空白、统一小写。
 *
 * 线索、客户、工作区查重共用同一口径；口径与 3.0.1 版本 server-core.ts 内的原实现一致。
 */
export function entityDuplicateKey(company: string, country: string) {
  const normalize = (value: string) => (value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return `${normalize(company)}|${normalize(country)}`;
}
