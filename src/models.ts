import type { ModelSpec } from "./types.js";

export const KIMI_MODELS: ModelSpec[] = [
  {
    id: "kimi-k2.6",
    inputPricePerMTok: 6.5,
    outputPricePerMTok: 27,
    cacheHitPricePerMTok: 1.1,
    contextWindow: 262_144,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "kimi-k2.5",
    inputPricePerMTok: 4,
    outputPricePerMTok: 21,
    cacheHitPricePerMTok: 0.7,
    contextWindow: 262_144,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "kimi-k2-0905-preview",
    inputPricePerMTok: 4,
    outputPricePerMTok: 16,
    cacheHitPricePerMTok: 1,
    contextWindow: 262_144,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "kimi-k2-0711-preview",
    inputPricePerMTok: 4,
    outputPricePerMTok: 16,
    cacheHitPricePerMTok: 1,
    contextWindow: 131_072,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "kimi-k2-turbo-preview",
    inputPricePerMTok: 8,
    outputPricePerMTok: 58,
    cacheHitPricePerMTok: 1,
    contextWindow: 262_144,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "kimi-k2-thinking",
    inputPricePerMTok: 4,
    outputPricePerMTok: 16,
    cacheHitPricePerMTok: 1,
    contextWindow: 262_144,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "kimi-k2-thinking-turbo",
    inputPricePerMTok: 8,
    outputPricePerMTok: 58,
    cacheHitPricePerMTok: 1,
    contextWindow: 262_144,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "moonshot-v1-8k",
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    cacheHitPricePerMTok: 2,
    contextWindow: 8_192,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "moonshot-v1-32k",
    inputPricePerMTok: 5,
    outputPricePerMTok: 20,
    cacheHitPricePerMTok: 5,
    contextWindow: 32_768,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "moonshot-v1-128k",
    inputPricePerMTok: 10,
    outputPricePerMTok: 30,
    cacheHitPricePerMTok: 10,
    contextWindow: 131_072,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "moonshot-v1-8k-vision-preview",
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    cacheHitPricePerMTok: 2,
    contextWindow: 8_192,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "moonshot-v1-32k-vision-preview",
    inputPricePerMTok: 5,
    outputPricePerMTok: 20,
    cacheHitPricePerMTok: 5,
    contextWindow: 32_768,
    pricingUnit: "CNY / 1M tokens",
  },
  {
    id: "moonshot-v1-128k-vision-preview",
    inputPricePerMTok: 10,
    outputPricePerMTok: 30,
    cacheHitPricePerMTok: 10,
    contextWindow: 131_072,
    pricingUnit: "CNY / 1M tokens",
  },
];

export const FEATURED_MODEL_IDS = [
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-k2-thinking",
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "moonshot-v1-128k",
] as const;

export function findModelSpec(modelId: string): ModelSpec | undefined {
  return KIMI_MODELS.find((item) => item.id === modelId);
}

export function formatContextWindow(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}
