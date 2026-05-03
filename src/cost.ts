import type { CostSummary, ModelSpec, UsageSummary } from "./types.js";

export function createUsageSummary(rawUsage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}): UsageSummary {
  const promptTokens = rawUsage?.prompt_tokens ?? 0;
  const completionTokens = rawUsage?.completion_tokens ?? 0;
  const cachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0;
  const totalTokens = rawUsage?.total_tokens ?? promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
  };
}

export function estimateCost(usage: UsageSummary, model: ModelSpec): CostSummary {
  const uncachedPromptTokens = Math.max(usage.promptTokens - usage.cachedTokens, 0);
  const inputCost = (uncachedPromptTokens * model.inputPricePerMTok) / 1_000_000;
  const outputCost = (usage.completionTokens * model.outputPricePerMTok) / 1_000_000;
  const cacheCost = (usage.cachedTokens * model.cacheHitPricePerMTok) / 1_000_000;

  return {
    inputCost,
    outputCost,
    cacheCost,
    totalCost: inputCost + outputCost + cacheCost,
  };
}

export function formatCny(value: number): string {
  return `¥${value.toFixed(6)}`;
}
