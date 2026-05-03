#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDataDir, loadConfig } from "./config.js";
import { formatCny } from "./cost.js";
import { runAgentTurn } from "./agent.js";
import { findModelSpec, formatContextWindow, KIMI_MODELS } from "./models.js";
import { deleteHistoryItem, ensureDataDir, getHistoryItem, listHistory, saveTurn } from "./storage.js";
import type { Interface } from "node:readline/promises";
import type { ChatMessage, CostSummary, ModelSpec, TurnRecord, UsageSummary } from "./types.js";

interface SessionTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  totalCost: number;
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
  console.log("  xilon-agent history list");
  console.log("  xilon-agent history show <id>");
  console.log("  xilon-agent history delete <id>");
}

async function executeTurn(
  sessionId: string,
  messages: ChatMessage[],
  totals: SessionTotals,
  userInput: string,
  model: ModelSpec,
): Promise<void> {
  const config = loadConfig();
  printRequest(messages, model.id, config.baseURL);

  printDivider("Assistant");
  const result = await runAgentTurn(config, messages, model, (text) => {
    process.stdout.write(text);
  });
  process.stdout.write("\n");

  printResponseMeta(result.responseMeta);
  printUsage("Usage", result.usage, result.cost);

  addUsage(totals, result.usage, result.cost);

  const turn: TurnRecord = {
    id: randomUUID().slice(0, 8),
    sessionId,
    createdAt: new Date().toISOString(),
    model: model.id,
    baseURL: config.baseURL,
    requestMessages: messages.map((message) => ({ ...message })),
    responseText: result.responseText,
    usage: result.usage,
    cost: result.cost,
  };

  await saveTurn(config.dataDir, turn);

  messages.push({ role: "assistant", content: result.responseText });
  console.log(`已保存历史记录：${turn.id}`);
  console.log(`本轮用户输入：${userInput.length} chars`);
}

async function runSinglePrompt(prompt: string): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  const rl = readline.createInterface({ input, output });
  const sessionId = randomUUID();
  const totals = createEmptyTotals();
  const model = await selectModel(rl, config.defaultModel);
  printSelectedModel(model);
  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: prompt },
  ];

  try {
    await executeTurn(sessionId, messages, totals, prompt, model);
    printSessionSummary(totals);
  } finally {
    rl.close();
  }
}

async function runInteractive(): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  const rl = readline.createInterface({ input, output });
  const sessionId = randomUUID();
  const totals = createEmptyTotals();
  const model = await selectModel(rl, config.defaultModel);
  const messages: ChatMessage[] = [{ role: "system", content: config.systemPrompt }];

  console.log("xilon-agent 已启动。");
  printSelectedModel(model);
  console.log("输入内容开始对话，输入 /exit 结束，输入 /help 查看帮助。");

  try {
    while (true) {
      const userInput = (await rl.question("\nYou> ")).trim();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      if (userInput === "/help") {
        console.log("/exit 退出当前会话");
        console.log("/help 查看帮助");
        console.log(`/model 当前模型：${model.id}`);
        console.log("/history-tip 使用 xilon-agent history list/show/delete 管理历史记录");
        continue;
      }

      messages.push({ role: "user", content: userInput });
      await executeTurn(sessionId, messages, totals, userInput, model);
    }
  } finally {
    rl.close();
    printSessionSummary(totals);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "history") {
    await handleHistoryCommand(rest);
    return;
  }

  if (command === "chat") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      console.error("请提供聊天内容，例如：xilon-agent chat 你好");
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
