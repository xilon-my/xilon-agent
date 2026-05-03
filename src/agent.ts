import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { createUsageSummary, estimateCost } from "./cost.js";
import type { ChatMessage, CostSummary, ModelSpec, UsageSummary } from "./types.js";

export interface AgentTurnResult {
  responseText: string;
  usage: UsageSummary;
  cost: CostSummary;
  responseMeta: {
    id?: string;
    object?: string;
    model?: string;
    finishReason?: string | null;
  };
}

export async function runAgentTurn(
  config: AppConfig,
  messages: ChatMessage[],
  model: ModelSpec,
  onTextDelta?: (text: string) => void,
): Promise<AgentTurnResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const stream = await client.chat.completions.create({
    model: model.id,
    messages,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  });

  let responseText = "";
  let usage = createUsageSummary();
  const responseMeta: AgentTurnResult["responseMeta"] = {};

  for await (const chunk of stream) {
    responseMeta.id = chunk.id;
    responseMeta.object = chunk.object;
    responseMeta.model = chunk.model;

    const deltaText = chunk.choices[0]?.delta?.content ?? "";
    if (deltaText) {
      responseText += deltaText;
      onTextDelta?.(deltaText);
    }

    const finishReason = chunk.choices[0]?.finish_reason;
    if (finishReason) {
      responseMeta.finishReason = finishReason;
    }

    if (chunk.usage) {
      usage = createUsageSummary(chunk.usage);
    }
  }

  const cost = estimateCost(usage, model);

  return {
    responseText,
    usage,
    cost,
    responseMeta,
  };
}
