import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { createUsageSummary, estimateCost } from "./cost.js";
import type { ChatMessage, CostSummary, ModelSpec, UsageSummary } from "./types.js";

const VISIBLE_REASONING_PROMPT = [
  "You are xilonagent, a transparent CLI coding assistant.",
  "For every reply, you MUST output exactly two XML blocks in this order:",
  "<analysis>...</analysis>",
  "<final>...</final>",
  "Rules for <analysis>: keep it concise, user-visible, action-oriented, 3-6 short lines max.",
  "Do not claim hidden internal reasoning. Summarize what you are checking, deciding, or doing next.",
  "Rules for <final>: the actual answer for the user.",
  "Do not output any text outside these two blocks.",
].join(" ");

export interface AgentTurnResult {
  responseText: string;
  analysisText: string;
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
  onStreamUpdate?: (update: { analysisText: string; responseText: string; rawText: string }) => void,
): Promise<AgentTurnResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const stream = await client.chat.completions.create({
    model: model.id,
    messages: [
      { role: "system", content: VISIBLE_REASONING_PROMPT },
      ...messages,
    ],
    stream: true,
    stream_options: {
      include_usage: true,
    },
  });

  let rawText = "";
  let responseText = "";
  let analysisText = "";
  let usage = createUsageSummary();
  const responseMeta: AgentTurnResult["responseMeta"] = {};

  for await (const chunk of stream) {
    responseMeta.id = chunk.id;
    responseMeta.object = chunk.object;
    responseMeta.model = chunk.model;

    const deltaText = chunk.choices[0]?.delta?.content ?? "";
    if (deltaText) {
      rawText += deltaText;
      const parsed = parseVisibleSections(rawText);
      analysisText = parsed.analysisText;
      responseText = parsed.responseText;
      onStreamUpdate?.({
        analysisText,
        responseText,
        rawText,
      });
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
    analysisText,
    usage,
    cost,
    responseMeta,
  };
}

function parseVisibleSections(rawText: string): { analysisText: string; responseText: string } {
  const analysisText = extractTagContent(rawText, "analysis");
  const responseText = extractTagContent(rawText, "final");

  return {
    analysisText: cleanupSection(analysisText),
    responseText: cleanupSection(responseText),
  };
}

function extractTagContent(source: string, tag: string): string {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const openIndex = source.indexOf(openTag);

  if (openIndex === -1) {
    return "";
  }

  const startIndex = openIndex + openTag.length;
  const closeIndex = source.indexOf(closeTag, startIndex);

  if (closeIndex === -1) {
    return source.slice(startIndex);
  }

  return source.slice(startIndex, closeIndex);
}

function cleanupSection(text: string): string {
  return text.replace(/^\s+/, "").replace(/\s+$/, "");
}
