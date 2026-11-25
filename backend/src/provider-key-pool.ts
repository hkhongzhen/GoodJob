import { createHmac } from "node:crypto";
import type { ProviderConfiguration } from "./credential-security.js";
import type { LeadProvider, TradeProvider } from "./provider-contract.js";
import type { ProviderConnection } from "./types.js";

export const MAX_PROVIDER_KEYS = 10;

export function supportsProviderKeyPool(provider: LeadProvider | TradeProvider) {
  return provider.id !== "sec_edgar" && ("search" in provider || "enrich" in provider);
}

export function providerApiKeys(config: ProviderConfiguration) {
  return [...new Set([config.apiKey, ...(config.backupApiKeys || [])].filter(Boolean))];
}

export function providerKeyId(connection: ProviderConnection, apiKey: string) {
  return createHmac("sha256", connection.credentialRef).update(apiKey).digest("hex");
}
