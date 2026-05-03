#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { clearLine, cursorTo } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDataDir, loadConfig } from "./config.js";
import { formatCny } from "./cost.js";
import { runAgentTurn } from "./agent.js";
import { findModelSpec, formatContextWindow, KIMI_MODELS } from "./models.js";
import { deleteHistoryItem, ensureDataDir, getHistoryItem, listHistory, saveTurn } from "./storage.js";
import { renderModelPickerScreen } from "./ui.js";
import type { Interface } from "node:readline/promises";
import type { ChatMessage, CostSummary, ModelSpec, TurnRecord, UsageSummary } from "./types.js";

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

function printRule(): void {
  console.log("-".repeat(Math.max(60, Math.min(process.stdout.columns ?? 100, 100))));
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

function printHistoryUsage(turn: TurnRecord): void {
  console.log(
    `${turn.id} | ${turn.createdAt} | ${turn.model} | total_tokens=${turn.usage.totalTokens} | total_cost=${formatCny(turn.cost.totalCost)}`,
  );
}

function formatRate(value: number): string {
  return `¥${value.toFixed(2)} / 1M`;
}

function printSessionHeader(model: ModelSpec): void {
  printRule();
  console.log(`模型  ${model.id}`);
  console.log(
    `价格  输入 ${formatRate(model.inputPricePerMTok)} · 输出 ${formatRate(model.outputPricePerMTok)} · 缓存 ${formatRate(model.cacheHitPricePerMTok)}`,
  );
  console.log(`窗口  ${formatContextWindow(model.contextWindow)}`);
  printRule();
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

async function selectModel(rl: Interface, defaultModelId?: string): Promise<ModelSpec> {
  let message = "";
  while (true) {
    renderModelPickerScreen({
      title: "xilonagent",
      models: KIMI_MODELS,
      defaultModelId,
      message,
    });

    const answer = (await rl.question("\nSelect Model > ")).trim();

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

    message = "输入无效，请输入模型序号或模型 id。";
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
  console.log(`\n>> ${userInput}`);
  printRule();
  console.log(`[Agent -> AI] ${userInput}`);

  let shownThinking = "思考中...";
  let streamedAnswer = "";
  let answerStarted = false;
  process.stdout.write(`[Thinking] ${shownThinking}`);

  const result = await runAgentTurn(config, state.messages, state.model, (update) => {
    const nextThinking = update.analysisText || "思考中...";
    if (!answerStarted && nextThinking !== shownThinking) {
      clearLine(output, 0);
      cursorTo(output, 0);
      process.stdout.write(`[Thinking] ${nextThinking}`);
      shownThinking = nextThinking;
    }

    if (update.responseText && !answerStarted) {
      answerStarted = true;
      process.stdout.write(`\n[AI -> Agent] `);
    }

    if (answerStarted) {
      const delta = update.responseText.slice(streamedAnswer.length);
      if (delta) {
        process.stdout.write(delta);
        streamedAnswer = update.responseText;
      }
    }
  });

  if (!answerStarted) {
    process.stdout.write(`\n[AI -> Agent] ${result.responseText}`);
  }
  process.stdout.write("\n");

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
    thinkingText: result.analysisText,
    responseText: result.responseText,
    usage: result.usage,
    cost: result.cost,
  };

  await saveTurn(config.dataDir, turn);

  state.messages.push({ role: "assistant", content: result.responseText });
  console.log(
    `本轮  输入:${result.usage.promptTokens} 缓存:${result.usage.cachedTokens} 输出:${result.usage.completionTokens} ${formatCny(result.cost.totalCost)}  |  累计  输入:${state.totals.promptTokens} 缓存:${state.totals.cachedTokens} 输出:${state.totals.completionTokens} ${formatCny(state.totals.totalCost)}`,
  );
  console.log(
    `meta  history_id:${turn.id}  response_id:${result.responseMeta.id ?? "-"}  finish_reason:${result.responseMeta.finishReason ?? "-"}`,
  );
  printRule();
}

async function runSinglePrompt(prompt: string): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  const rl = readline.createInterface({ input, output });
  const model = await selectModel(rl, config.defaultModel);
  const state = createSessionState(model, config.systemPrompt);

  try {
    printSessionHeader(model);
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

  printSessionHeader(model);
  console.log("输入消息开始对话，新的对话会继续追加在下方。");
  console.log("每轮显示 [Agent -> AI]、[Thinking]、[AI -> Agent] 和统计信息。");
  printRule();

  try {
    while (true) {
      const prompt = "\n>> ";
      const userInput = (await rl.question(prompt)).trim();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      if (userInput === "/help") {
        printHelp();
        continue;
      }

      if (userInput === "/stats") {
        console.log(
          `累计统计  turns:${state.turnCount}  messages:${state.messages.length - 1}  total_tokens:${state.totals.totalTokens}  total_cost:${formatCny(state.totals.totalCost)}`,
        );
        continue;
      }

      if (userInput === "/model") {
        printSessionHeader(state.model);
        continue;
      }

      if (userInput === "/clear") {
        state = createSessionState(state.model, config.systemPrompt);
        console.log("\n上下文已清空，新的会话会从下一条输入开始。");
        printRule();
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
