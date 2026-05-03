import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type { AppConfig } from "./config.js";
import { createUsageSummary, estimateCost } from "./cost.js";
import type { ChatMessage, CostSummary, ModelSpec, UsageSummary } from "./types.js";
import { executeToolCall, getAgentTools } from "./tools.js";
import type { ToolExecutionContext, ToolTrace } from "./tools.js";

const VISIBLE_REASONING_PROMPT = [
  "You are xilonagent, a polished CLI coding assistant.",
  "Act like a reliable terminal agent: direct, calm, specific, and concise.",
  "Match the user's language in the final answer by default.",
  "If the user writes in Chinese, reply in Chinese. If the user writes in English, reply in English.",
  "Only switch languages when the user explicitly asks you to do so.",
  "Use tools when they materially help. Do not narrate obvious actions.",
  "For multi-step work, keep the todo list current with todo_write.",
  "Save only stable, reusable facts with save_memory.",
  "Use delegate_task only for focused subproblems that benefit from a helper.",
  "When giving a user-visible response, you MUST output exactly two XML blocks in this order:",
  "<analysis>...</analysis>",
  "<final>...</final>",
  "Rules for <analysis>: short progress update only, 1-3 brief lines max.",
  "Do not expose chain-of-thought or speculate. Only state current checks, tool use, or next step.",
  "Rules for <final>: answer like a strong coding assistant in clean Markdown.",
  "Prefer compact structure, actionable wording, and explicit outcomes.",
  "When mentioning commands, files, or identifiers, wrap them in backticks.",
  "Do not repeat tool logs verbatim unless useful to the user.",
  "Do not output any text outside these two blocks.",
].join(" ");

export interface AgentTurnResult {
  responseText: string;
  analysisText: string;
  toolTraces: ToolTrace[];
  usage: UsageSummary;
  cost: CostSummary;
  responseMeta: {
    id?: string;
    object?: string;
    model?: string;
    finishReason?: string | null;
  };
}

export type AgentEvent =
  | { type: "analysis"; text: string }
  | { type: "tool_call"; toolName: string; argumentsText: string }
  | { type: "tool_result"; toolName: string; summary: string; outputPreview: string }
  | { type: "final"; analysisText: string; responseText: string };

export async function runAgentTurn(
  config: AppConfig,
  messages: ChatMessage[],
  model: ModelSpec,
  toolContext: ToolExecutionContext,
  onEvent?: (event: AgentEvent) => void,
  memoryContext?: string,
): Promise<AgentTurnResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const tools = await getAgentTools(config);

  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: VISIBLE_REASONING_PROMPT },
    ...(memoryContext?.trim()
      ? [
          {
            role: "system" as const,
            content: `Relevant long-term memory for this request:\n${memoryContext.trim()}`,
          },
        ]
      : []),
    ...messages.map(
      (message) =>
        ({
          role: message.role,
          content: message.content,
        }) satisfies ChatCompletionMessageParam,
    ),
  ];

  const toolTraces: ToolTrace[] = [];
  let usage = createUsageSummary();
  const responseMeta: AgentTurnResult["responseMeta"] = {};
  let finalAnalysisText = "";
  let finalResponseText = "";
  for (let step = 0; step < 6; step += 1) {
    const completion = await client.chat.completions.create({
      model: model.id,
      messages: conversation,
      tools,
      tool_choice: "auto",
    });

    responseMeta.id = completion.id;
    responseMeta.object = completion.object;
    responseMeta.model = completion.model;
    responseMeta.finishReason = completion.choices[0]?.finish_reason ?? null;
    usage = createUsageSummary(completion.usage);

    const message = completion.choices[0]?.message;
    const rawContent = message?.content ?? "";
    const parsed = parseVisibleSections(rawContent);
    const reasoningContent = resolveReasoningContent(message, parsed.analysisText);
    if (parsed.analysisText) {
      finalAnalysisText = parsed.analysisText;
      onEvent?.({ type: "analysis", text: parsed.analysisText });
    }

    const assistantMessage: ChatCompletionAssistantMessageParam & {
      reasoning_content?: string;
    } = {
      role: "assistant",
      content: message?.content ?? null,
      tool_calls: message?.tool_calls,
    };
    if (reasoningContent) {
      assistantMessage.reasoning_content = reasoningContent;
    }
    conversation.push(assistantMessage);

    if (message?.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") {
          continue;
        }

        const toolName = toolCall.function.name;
        const argumentsText = toolCall.function.arguments;
        onEvent?.({ type: "tool_call", toolName, argumentsText });

        const result = await executeToolCall(toolName, argumentsText, toolContext);
        const outputPreview = result.content;
        toolTraces.push({
          name: toolName,
          argumentsText,
          resultSummary: result.summary,
          outputPreview,
        });

        onEvent?.({
          type: "tool_result",
          toolName,
          summary: result.summary,
          outputPreview,
        });

        const toolMessage: ChatCompletionToolMessageParam = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.content,
        };
        conversation.push(toolMessage);
      }

      continue;
    }

    finalResponseText = resolveVisibleResponse(parsed.analysisText, parsed.responseText, rawContent);
    break;
  }

  const streamed = await streamFinalVisibleResponse(
    client,
    model.id,
    conversation,
    finalAnalysisText,
    finalResponseText,
    (event) => onEvent?.(event),
  );
  finalAnalysisText = streamed.analysisText;
  finalResponseText = streamed.responseText;
  responseMeta.id = streamed.responseMeta.id ?? responseMeta.id;
  responseMeta.object = streamed.responseMeta.object ?? responseMeta.object;
  responseMeta.model = streamed.responseMeta.model ?? responseMeta.model;
  responseMeta.finishReason = streamed.responseMeta.finishReason ?? responseMeta.finishReason;
  usage = mergeUsage(usage, streamed.usage);

  const cost = estimateCost(usage, model);

  return {
    responseText: finalResponseText,
    analysisText: finalAnalysisText,
    toolTraces,
    usage,
    cost,
    responseMeta,
  };
}

async function streamFinalVisibleResponse(
  client: OpenAI,
  modelId: string,
  conversation: ChatCompletionMessageParam[],
  fallbackAnalysis: string,
  fallbackResponse: string,
  onEvent?: (event: AgentEvent) => void,
): Promise<{
  analysisText: string;
  responseText: string;
  usage: UsageSummary;
  responseMeta: AgentTurnResult["responseMeta"];
}> {
  const finalPrompt: ChatCompletionMessageParam[] = [
    ...conversation,
    {
      role: "system",
      content: [
        "Now produce the final user-visible output.",
        "Do not call tools.",
        "Output exactly two XML blocks:",
        "<analysis>short visible progress update</analysis>",
        "<final>clean markdown answer</final>",
        "Keep analysis brief and keep the final answer crisp, structured, and user-facing.",
      ].join(" "),
    },
  ];

  const stream = await client.chat.completions.create({
    model: modelId,
    messages: finalPrompt,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  });

  let rawText = "";
  let analysisText = fallbackAnalysis;
  let responseText = "";
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

      if (parsed.analysisText) {
        analysisText = parsed.analysisText;
        onEvent?.({ type: "analysis", text: analysisText });
      }

      const nextResponse = resolveStreamingResponse(parsed);
      if (nextResponse !== responseText) {
        responseText = nextResponse;
        onEvent?.({
          type: "final",
          analysisText,
          responseText,
        });
      }
    }

    const finishReason = chunk.choices[0]?.finish_reason;
    if (finishReason) {
      responseMeta.finishReason = finishReason;
    }

    if (chunk.usage) {
      usage = createUsageSummary(chunk.usage);
    }
  }

  return {
    analysisText: analysisText || fallbackAnalysis,
    responseText: responseText || fallbackResponse || "收到。",
    usage,
    responseMeta,
  };
}

function parseVisibleSections(rawText: string): {
  analysisText: string;
  responseText: string;
  hasFinalOpenTag: boolean;
  hasFinalCloseTag: boolean;
} {
  const analysisText = extractTagContent(rawText, "analysis");
  const responseText = extractTagContent(rawText, "final");
  const hasFinalOpenTag = rawText.includes("<final>");
  const hasFinalCloseTag = rawText.includes("</final>");

  return {
    analysisText: cleanupSection(analysisText),
    responseText: cleanupSection(responseText),
    hasFinalOpenTag,
    hasFinalCloseTag,
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
  return sanitizeVisibleText(text);
}

function sanitizeVisibleText(text: string): string {
  return text
    .replace(/<\/?[^>\n]+>/g, "")
    .replace(/<[/!a-zA-Z\u4e00-\u9fff][^<\n]*$/g, "")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

function resolveReasoningContent(
  message: { content?: string | null } | undefined,
  parsedAnalysisText: string,
): string {
  const reasoningFromMessage = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
  if (typeof reasoningFromMessage === "string" && reasoningFromMessage.trim()) {
    return cleanupSection(reasoningFromMessage);
  }

  if (parsedAnalysisText.trim()) {
    return parsedAnalysisText.trim();
  }

  return "Working through the request.";
}

function mergeUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
  };
}

function resolveVisibleResponse(analysisText: string, responseText: string, rawContent: string): string {
  if (responseText.trim()) {
    return sanitizeVisibleText(responseText);
  }

  const stripped = sanitizeVisibleText(
    rawContent
      .replace(/<analysis>[\s\S]*?<\/analysis>/g, "")
      .replace(/<final>/g, "")
      .replace(/<\/final>/g, ""),
  );
  if (stripped) {
    return stripped;
  }

  if (analysisText.trim()) {
    return analysisText.trim();
  }

  return "收到。";
}

function resolveStreamingResponse(parsed: {
  responseText: string;
  hasFinalOpenTag: boolean;
}): string {
  if (!parsed.hasFinalOpenTag) {
    return "";
  }

  return sanitizeVisibleText(parsed.responseText);
}
