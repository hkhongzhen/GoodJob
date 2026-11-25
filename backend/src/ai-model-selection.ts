import type { CrmStore } from "./store.js";

export function listAiModelConfigs(store: CrmStore, ownerId: string, teamId: string) {
  return store.aiModelConfigs
    .filter((item) => item.ownerId === ownerId && item.teamId === teamId)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function currentAiModelConfig(store: CrmStore, ownerId: string, teamId: string) {
  // Older accounts can have several enabled models. Resolve them the same way for every feature.
  return listAiModelConfigs(store, ownerId, teamId).find((item) => item.enabled && item.apiKey);
}
