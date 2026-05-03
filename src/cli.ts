#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDataDir, loadConfig } from "./config.js";
import { formatCny } from "./cost.js";
import { runAgentTurn } from "./agent.js";
import { findModelSpec, formatContextWindow, KIMI_MODELS } from "./models.js";
import { deleteHistoryItem, ensureDataDir, getHistoryItem, listHistory, saveTurn } from "./storage.js";
import { renderInteractiveScreen } from "./ui.js";
import type { Interface } from "node:readline/promises";
import type { ChatMessage, CostSummary, ModelSpec, TurnRecord, UsageSummary } from "./types.js";
import type { TranscriptEntry } from "./ui.js";

interface SessionTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  totalCost: number;
}

interface SessionState {
  sessionId: string;
  model: ModelSpec;
  messages: ChatMessage[];
  transcript: TranscriptEntry[];
  totals: SessionTotals;
  turnCount: number;
  footerLines: string[];
  lastUsage?: UsageSummary;
  lastCost?: CostSummary;
}

function createEmptyTotals(): SessionTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    totalCost: 0,
  };
}

function createSessionState(model: ModelSpec, systemPrompt: string): SessionState {
  return {
    sessionId: randomUUID(),
    model,
    messages: [{ role: "system", content: systemPrompt }],
    transcript: [],
    totals: createEmptyTotals(),
    turnCount: 0,
    footerLines: [],
  };
}

function addUsage(totals: SessionTotals, usage: UsageSummary, cost: CostSummary): void {
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
  totals.cachedTokens += usage.cachedTokens;
  totals.totalCost += cost.totalCost;
}

function printDivider(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printBanner(): void {
  console.log("--------------------------------------------------");
  console.log("xilonagent");
  console.log("Transparent CLI agent for Kimi");
  console.log("--------------------------------------------------");
}

function printUsage(label: string, usage: UsageSummary, cost: CostSummary): void {
  printDivider(label);
  console.log(`prompt_tokens: ${usage.promptTokens}`);
  console.log(`completion_tokens: ${usage.completionTokens}`);
  console.log(`cached_tokens: ${usage.cachedTokens}`);
  console.log(`total_tokens: ${usage.totalTokens}`);
  console.log(`input_cost: ${formatCny(cost.inputCost)}`);
  console.log(`output_cost: ${formatCny(cost.outputCost)}`);
  console.log(`cache_cost: ${formatCny(cost.cacheCost)}`);
  console.log(`total_cost: ${formatCny(cost.totalCost)}`);
}

function printSessionSummary(totals: SessionTotals): void {
  printDivider("Session Summary");
  console.log(`prompt_tokens: ${totals.promptTokens}`);
  console.log(`completion_tokens: ${totals.completionTokens}`);
  console.log(`cached_tokens: ${totals.cachedTokens}`);
  console.log(`total_tokens: ${totals.totalTokens}`);
  console.log(`total_cost: ${formatCny(totals.totalCost)}`);
}

function printShortStatus(state: SessionState): void {
  printDivider("Session");
  console.log(`model: ${state.model.id}`);
  console.log(`turns: ${state.turnCount}`);
  console.log(`messages: ${state.messages.length - 1}`);
  console.log(`total_tokens: ${state.totals.totalTokens}`);
  console.log(`total_cost: ${formatCny(state.totals.totalCost)}`);
}

function printRequest(messages: ChatMessage[], model: string, baseURL: string): void {
  printDivider("Request");
  console.log(
    JSON.stringify(
      {
        model,
        baseURL,
        messages,
      },
      null,
      2,
    ),
  );
}

function printResponseMeta(rawResponse: {
  id?: string;
  object?: string;
  model?: string;
  finishReason?: string | null;
}): void {
  printDivider("Response Meta");
  console.log(
    JSON.stringify(
      {
        id: rawResponse.id,
        object: rawResponse.object,
        model: rawResponse.model,
        finish_reason: rawResponse.finishReason ?? null,
      },
      null,
      2,
    ),
  );
}

function printHistoryUsage(turn: TurnRecord): void {
  console.log(
    `${turn.id} | ${turn.createdAt} | ${turn.model} | total_tokens=${turn.usage.totalTokens} | total_cost=${formatCny(turn.cost.totalCost)}`,
  );
}

function formatRate(value: number): string {
  return `¥${value.toFixed(2)} / 1M`;
}

function printSelectedModel(model: ModelSpec): void {
  printDivider("Selected Model");
  console.log(`model: ${model.id}`);
  console.log(`context_window: ${formatContextWindow(model.contextWindow)}`);
  console.log(`input_cache_hit_price: ${formatRate(model.cacheHitPricePerMTok)}`);
  console.log(`input_cache_miss_price: ${formatRate(model.inputPricePerMTok)}`);
  console.log(`output_price: ${formatRate(model.outputPricePerMTok)}`);
}

function printHelp(): void {
  printDivider("Commands");
  console.log("/help    查看帮助");
  console.log("/stats   查看当前会话统计");
  console.log("/model   查看当前模型");
  console.log("/clear   清空当前会话上下文");
  console.log("/exit    退出");
  console.log("/history-tip 使用 xilonagent history list/show/delete 管理历史记录");
}

function buildFooterLines(state: SessionState): string[] {
  return state.footerLines;
}

function toUsageSummary(totals: SessionTotals): UsageSummary {
  return {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    cachedTokens: totals.cachedTokens,
  };
}

function toCostSummary(totals: SessionTotals): CostSummary {
  return {
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: totals.totalCost,
  };
}

function refreshInteractiveScreen(state: SessionState): void {
  renderInteractiveScreen({
    title: "xilonagent",
    model: state.model,
    transcript: state.transcript,
    turnCount: state.turnCount,
    totalUsage: toUsageSummary(state.totals),
    totalCost: toCostSummary(state.totals),
    lastUsage: state.lastUsage,
    lastCost: state.lastCost,
    footerLines: buildFooterLines(state),
  });
}

async function selectModel(rl: Interface, defaultModelId?: string): Promise<ModelSpec> {
  printDivider("Model List");
  KIMI_MODELS.forEach((model, index) => {
    const defaultTag = model.id === defaultModelId ? " [default]" : "";
    console.log(
      `${index + 1}. ${model.id}${defaultTag} | ctx=${formatContextWindow(model.contextWindow)} | in_hit=${formatRate(model.cacheHitPricePerMTok)} | in=${formatRate(model.inputPricePerMTok)} | out=${formatRate(model.outputPricePerMTok)}`,
    );
  });

  while (true) {
    const suffix = defaultModelId ? `，直接回车使用 ${defaultModelId}` : "";
    const answer = (await rl.question(`\n请选择模型序号${suffix}: `)).trim();

    if (!answer && defaultModelId) {
      const defaultModel = findModelSpec(defaultModelId);
      if (defaultModel) {
        return defaultModel;
      }
    }

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= KIMI_MODELS.length) {
      return KIMI_MODELS[index - 1];
    }

    const byId = findModelSpec(answer);
    if (byId) {
      return byId;
    }

    console.log("输入无效，请输入模型序号或模型 id。");
  }
}

async function handleHistoryCommand(args: string[]): Promise<void> {
  const dataDir = getDataDir();
  await ensureDataDir(dataDir);

  const subcommand = args[0];

  if (subcommand === "list") {
    const items = await listHistory(dataDir);
    if (items.length === 0) {
      console.log("暂无历史记录。");
      return;
    }

    for (const item of items) {
      printHistoryUsage(item.turn);
    }
    return;
  }

  if (subcommand === "show") {
    const id = args[1];
    if (!id) {
      console.error("请提供历史记录 id，例如：xilon-agent history show <id>");
      process.exitCode = 1;
      return;
    }

    const item = await getHistoryItem(dataDir, id);
    if (!item) {
      console.error(`未找到历史记录：${id}`);
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify(item.turn, null, 2));
    return;
  }

  if (subcommand === "delete") {
    const id = args[1];
    if (!id) {
      console.error("请提供历史记录 id，例如：xilon-agent history delete <id>");
      process.exitCode = 1;
      return;
    }

    const deleted = await deleteHistoryItem(dataDir, id);
    if (!deleted) {
      console.error(`未找到历史记录：${id}`);
      process.exitCode = 1;
      return;
    }

    console.log(`已删除历史记录：${id}`);
    return;
  }

  console.log("用法：");
  console.log("  xilonagent history list");
  console.log("  xilonagent history show <id>");
  console.log("  xilonagent history delete <id>");
}

async function executeTurn(
  state: SessionState,
  userInput: string,
): Promise<void> {
  const config = loadConfig();
  state.messages.push({ role: "user", content: userInput });
  state.transcript.push({ role: "user", content: userInput });
  const assistantEntry: TranscriptEntry = { role: "assistant", content: "" };
  state.transcript.push(assistantEntry);
  state.footerLines = [
    `baseURL: ${config.baseURL}`,
    `request_messages: ${state.messages.length}`,
    "状态: 正在请求模型...",
  ];
  refreshInteractiveScreen(state);

  let lastRenderAt = 0;
  const result = await runAgentTurn(config, state.messages, state.model, (text) => {
    assistantEntry.content += text;
    const now = Date.now();
    if (now - lastRenderAt >= 50) {
      state.footerLines = [
        `baseURL: ${config.baseURL}`,
        `request_messages: ${state.messages.length}`,
        "状态: 正在流式输出...",
      ];
      refreshInteractiveScreen(state);
      lastRenderAt = now;
    }
  });

  addUsage(state.totals, result.usage, result.cost);
  state.turnCount += 1;
  state.lastUsage = result.usage;
  state.lastCost = result.cost;

  const turn: TurnRecord = {
    id: randomUUID().slice(0, 8),
    sessionId: state.sessionId,
    createdAt: new Date().toISOString(),
    model: state.model.id,
    baseURL: config.baseURL,
    requestMessages: state.messages.map((message) => ({ ...message })),
    responseText: result.responseText,
    usage: result.usage,
    cost: result.cost,
  };

  await saveTurn(config.dataDir, turn);

  state.messages.push({ role: "assistant", content: result.responseText });
  assistantEntry.content = result.responseText;
  state.footerLines = [
    `history_id: ${turn.id}`,
    `response_id: ${result.responseMeta.id ?? "-"}`,
    `finish_reason: ${result.responseMeta.finishReason ?? "-"}`,
  ];
  refreshInteractiveScreen(state);
}

async function runSinglePrompt(prompt: string): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  const rl = readline.createInterface({ input, output });
  const model = await selectModel(rl, config.defaultModel);
  const state = createSessionState(model, config.systemPrompt);

  try {
    await executeTurn(state, prompt);
    printSessionSummary(state.totals);
  } finally {
    rl.close();
  }
}

async function runInteractive(): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  const rl = readline.createInterface({ input, output });
  const model = await selectModel(rl, config.defaultModel);
  let state = createSessionState(model, config.systemPrompt);

  state.footerLines = [
    `model: ${model.id}`,
    "输入消息开始对话，使用 /help 查看命令",
  ];
  refreshInteractiveScreen(state);

  try {
    while (true) {
      const prompt = `\nxilonagent(${state.model.id})> `;
      const userInput = (await rl.question(prompt)).trim();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      if (userInput === "/help") {
        state.footerLines = [
          "/help   查看帮助",
          "/stats  查看当前会话统计",
          "/model  查看当前模型价格信息",
          "/clear  清空当前会话上下文",
          "/exit   退出当前会话",
        ];
        refreshInteractiveScreen(state);
        continue;
      }

      if (userInput === "/stats") {
        state.footerLines = [
          `turns: ${state.turnCount}`,
          `messages: ${state.messages.length - 1}`,
          `total_tokens: ${state.totals.totalTokens}`,
          `total_cost: ${formatCny(state.totals.totalCost)}`,
        ];
        refreshInteractiveScreen(state);
        continue;
      }

      if (userInput === "/model") {
        state.footerLines = [
          `model: ${state.model.id}`,
          `context: ${formatContextWindow(state.model.contextWindow)}`,
          `input: ${formatRate(state.model.inputPricePerMTok)}`,
          `output: ${formatRate(state.model.outputPricePerMTok)}`,
          `cache: ${formatRate(state.model.cacheHitPricePerMTok)}`,
        ];
        refreshInteractiveScreen(state);
        continue;
      }

      if (userInput === "/clear") {
        state = createSessionState(state.model, config.systemPrompt);
        state.footerLines = ["当前会话上下文已清空。"];
        refreshInteractiveScreen(state);
        continue;
      }

      await executeTurn(state, userInput);
    }
  } finally {
    rl.close();
    printSessionSummary(state.totals);
  }
}

async function main(): Promise<void> {
  if (!existsSync(new URL("../.env", import.meta.url))) {
    console.error("未找到 .env，请先复制 .env.example 并填写 Kimi API Key。");
    process.exitCode = 1;
    return;
  }

  const [command, ...rest] = process.argv.slice(2);

  if (command === "history") {
    await handleHistoryCommand(rest);
    return;
  }

  if (command === "chat") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      console.error("请提供聊天内容，例如：xilonagent chat 你好");
      process.exitCode = 1;
      return;
    }

    await runSinglePrompt(prompt);
    return;
  }

  await runInteractive();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`运行失败：${message}`);
  process.exitCode = 1;
});
