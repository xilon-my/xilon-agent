export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface CostSummary {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
}

export interface ModelSpec {
  id: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheHitPricePerMTok: number;
  contextWindow: number;
  pricingUnit: string;
  note?: string;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  model: string;
  baseURL: string;
  requestMessages: ChatMessage[];
  thinkingText?: string;
  responseText: string;
  usage: UsageSummary;
  cost: CostSummary;
}
