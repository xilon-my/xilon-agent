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

export interface SessionTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  totalCost: number;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  updatedAt: string;
}

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  scope: "project" | "user";
  updatedAt: string;
  lastUsedAt: string;
}

export type PermissionMode = "ask" | "allow" | "deny";

export interface SessionSnapshot {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  summary: string;
  messages: ChatMessage[];
  totals: SessionTotals;
  todos: TodoItem[];
  compressedSummary?: string;
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
  toolTraces?: Array<{
    name: string;
    argumentsText: string;
    resultSummary: string;
    outputPreview: string;
  }>;
  usage: UsageSummary;
  cost: CostSummary;
}
