#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { clearLine, cursorTo, emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDataDir, loadConfig } from "./config.js";
import { compressMessages } from "./context.js";
import { formatCny } from "./cost.js";
import { getMemoryContext } from "./memory.js";
import type { PermissionRequest } from "./permissions.js";
import { runAgentTurn } from "./agent.js";
import { runFeishuBridge } from "./feishu.js";
import { FEATURED_MODEL_IDS, findModelSpec, formatContextWindow } from "./models.js";
import {
  deleteHistoryItem,
  ensureDataDir,
  getHistoryItem,
  getSessionSnapshot,
  listHistory,
  listSessionSnapshots,
  saveSessionSnapshot,
  saveTurn,
} from "./storage.js";
import type {
  ChatMessage,
  CostSummary,
  ModelSpec,
  SessionSnapshot,
  SessionTotals,
  TodoItem,
  TurnRecord,
  UsageSummary,
} from "./types.js";
import type { ToolTrace } from "./tools.js";

interface SessionState {
  sessionId: string;
  createdAt: string;
  model: ModelSpec;
  messages: ChatMessage[];
  totals: SessionTotals;
  turnCount: number;
  todos: TodoItem[];
  compressedSummary?: string;
  lastUsage?: UsageSummary;
  lastCost?: CostSummary;
}

interface SlashCommandOption {
  command: string;
  label: string;
  description: string;
}

interface SessionTurnEntry {
  turnNumber: number;
  userText: string;
  assistantText: string;
  messageStart: number;
  messageEnd: number;
}

const SLASH_COMMANDS: SlashCommandOption[] = [
  { command: "/help", label: "帮助", description: "查看可用命令" },
  { command: "/history", label: "历史", description: "查看本轮对话列表并删除部分上下文" },
  { command: "/todos", label: "待办", description: "查看当前任务列表" },
  { command: "/plan", label: "计划", description: "让 agent 为当前目标建立 todo 列表" },
  { command: "/sessions", label: "会话", description: "查看并恢复历史会话" },
  { command: "/resume", label: "恢复", description: "恢复最近一次保存的会话" },
  { command: "/stats", label: "统计", description: "查看当前会话统计" },
  { command: "/model", label: "模型", description: "切换当前模型" },
  { command: "/clear", label: "清空", description: "清空当前会话上下文" },
  { command: "/exit", label: "退出", description: "结束当前会话" },
];

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bright: "\u001b[1m",
  gray: "\u001b[90m",
  white: "\u001b[37m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
};

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
    createdAt: new Date().toISOString(),
    model,
    messages: [{ role: "system", content: systemPrompt }],
    totals: createEmptyTotals(),
    turnCount: 0,
    todos: [],
  };
}

function colorize(value: string, color: string): string {
  return `${color}${value}${ANSI.reset}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function getDisplayWidth(text: string): number {
  let width = 0;
  const plain = stripAnsi(text);

  for (const char of plain) {
    if (char === "\t") {
      width += 2;
      continue;
    }
    width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
  }

  return width;
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateForDisplay(text: string, maxWidth: number): string {
  const normalized = toSingleLine(text);
  if (!normalized) {
    return "(空)";
  }

  let result = "";
  let width = 0;
  for (const char of normalized) {
    const charWidth = getDisplayWidth(char);
    if (width + charWidth > maxWidth - 1) {
      return `${result}…`;
    }
    result += char;
    width += charWidth;
  }
  return result;
}

function buildSessionTurns(messages: ChatMessage[]): SessionTurnEntry[] {
  const entries: SessionTurnEntry[] = [];
  let turnNumber = 0;

  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }

    turnNumber += 1;
    const assistantMessage = messages[index + 1]?.role === "assistant" ? messages[index + 1] : undefined;
    entries.push({
      turnNumber,
      userText: message.content,
      assistantText: assistantMessage?.content ?? "",
      messageStart: index,
      messageEnd: assistantMessage ? index + 1 : index,
    });

    if (assistantMessage) {
      index += 1;
    }
  }

  return entries;
}

function removeSessionTurns(state: SessionState, turnNumbers: number[]): number {
  const selected = new Set(turnNumbers);
  if (selected.size === 0) {
    return 0;
  }

  const turns = buildSessionTurns(state.messages);
  const removedRanges = turns.filter((entry) => selected.has(entry.turnNumber));
  if (removedRanges.length === 0) {
    return 0;
  }

  const keepMessages: ChatMessage[] = [state.messages[0]];
  for (let index = 1; index < state.messages.length; index += 1) {
    const shouldRemove = removedRanges.some((entry) => index >= entry.messageStart && index <= entry.messageEnd);
    if (!shouldRemove) {
      keepMessages.push(state.messages[index]);
    }
  }

  state.messages = keepMessages;
  state.turnCount = buildSessionTurns(state.messages).length;
  return removedRanges.length;
}

function buildSessionSummary(state: SessionState): string {
  const lastUserMessage = [...state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  return truncateForDisplay(lastUserMessage || "新会话", 72);
}

function createSessionSnapshot(state: SessionState): SessionSnapshot {
  return {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    model: state.model.id,
    summary: buildSessionSummary(state),
    messages: state.messages,
    totals: state.totals,
    todos: state.todos,
    compressedSummary: state.compressedSummary,
  };
}

function restoreSessionState(snapshot: SessionSnapshot, model: ModelSpec): SessionState {
  return {
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt,
    model,
    messages: snapshot.messages,
    totals: snapshot.totals,
    turnCount: buildSessionTurns(snapshot.messages).length,
    todos: snapshot.todos ?? [],
    compressedSummary: snapshot.compressedSummary,
  };
}

async function persistSessionState(state: SessionState): Promise<void> {
  const config = loadConfig();
  await saveSessionSnapshot(config.dataDir, createSessionSnapshot(state));
}

function printTodoList(todos: TodoItem[]): void {
  if (todos.length === 0) {
    console.log(colorize("暂无待办项。", `${ANSI.dim}${ANSI.gray}`));
    return;
  }

  for (const item of todos) {
    const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
    console.log(`${marker} ${item.id}  ${item.content}`);
  }
}

async function requestPermissionApproval(request: PermissionRequest): Promise<boolean> {
  if (!input.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log("");
    printLabel("Permission", ANSI.yellow, request.toolName);
    console.log(`  ${request.summary}`);
    const answer = (await rl.question("  允许执行? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function promptSessionResumeSelection(currentSessionId?: string): Promise<SessionSnapshot | null> {
  const config = loadConfig();
  const sessions = (await listSessionSnapshots(config.dataDir)).filter((item) => item.sessionId !== currentSessionId);
  if (sessions.length === 0) {
    console.log("没有可恢复的会话。");
    return null;
  }

  if (!input.isTTY) {
    return sessions[0]?.session ?? null;
  }

  emitKeypressEvents(input);
  input.resume();
  input.setRawMode(true);

  return await new Promise<SessionSnapshot | null>((resolve, reject) => {
    let selectedIndex = 0;
    const prompt = "resume > ";

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
    };

    const render = (): void => {
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
      output.write(colorize(`${prompt}选择会话并回车恢复`, `${ANSI.bright}${ANSI.cyan}`));

      for (let index = 0; index < sessions.length; index += 1) {
        const item = sessions[index];
        const active = index === selectedIndex;
        const marker = active ? colorize(">", `${ANSI.bright}${ANSI.white}`) : colorize(" ", `${ANSI.dim}${ANSI.gray}`);
        const summary = `${item.session.model}  ${truncateForDisplay(item.session.summary, 46)}`;
        const line = active ? colorize(summary, `${ANSI.bright}${ANSI.white}`) : colorize(summary, `${ANSI.dim}${ANSI.gray}`);
        output.write(`\n${marker} ${line}`);
      }

      output.write(`\x1b[${sessions.length}A`);
      cursorTo(output, getDisplayWidth(prompt));
    };

    const finish = (session: SessionSnapshot | null): void => {
      cleanup();
      resolve(session);
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("用户中断"));
        return;
      }
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + sessions.length) % sessions.length;
        render();
        return;
      }
      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % sessions.length;
        render();
        return;
      }
      if (key.name === "return") {
        finish(sessions[selectedIndex]?.session ?? null);
        return;
      }
      if (key.name === "escape") {
        finish(null);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

function printTextBlock(text: string, color?: string): void {
  for (const line of text.split("\n")) {
    const rendered = color ? colorize(line, color) : line;
    console.log(`  ${rendered}`);
  }
}

function printLabel(label: string, color: string, detail?: string): void {
  const head = colorize(label, color);
  console.log(detail ? `${head} ${detail}` : head);
}

function addUsage(totals: SessionTotals, usage: UsageSummary, cost: CostSummary): void {
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
  totals.cachedTokens += usage.cachedTokens;
  totals.totalCost += cost.totalCost;
}

function printRule(): void {
  console.log(colorize("-".repeat(Math.max(60, Math.min(process.stdout.columns ?? 100, 100))), `${ANSI.dim}${ANSI.gray}`));
}

function printDivider(title: string): void {
  console.log(`\n${colorize(title, `${ANSI.bright}${ANSI.white}`)}`);
}

function printSessionSummary(totals: SessionTotals): void {
  printDivider("Session Summary");
  console.log(colorize(`prompt ${totals.promptTokens}  completion ${totals.completionTokens}  cache ${totals.cachedTokens}`, `${ANSI.dim}${ANSI.gray}`));
  console.log(colorize(`total ${totals.totalTokens}  cost ${formatCny(totals.totalCost)}`, `${ANSI.dim}${ANSI.gray}`));
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
  const title = colorize("xilonagent", `${ANSI.bright}${ANSI.white}`);
  const meta = colorize(model.id, ANSI.cyan);
  printRule();
  console.log(`${title}  ${meta}`);
  console.log(
    colorize(
      `context ${formatContextWindow(model.contextWindow)}  |  in ${formatRate(model.inputPricePerMTok)}  out ${formatRate(model.outputPricePerMTok)}  cache ${formatRate(model.cacheHitPricePerMTok)}`,
      `${ANSI.dim}${ANSI.gray}`,
    ),
  );
  console.log(colorize("commands /help  /history  /todos  /plan  /sessions  /resume  /model  /clear  /exit", `${ANSI.dim}${ANSI.gray}`));
  printRule();
}

function getFilteredSlashCommands(buffer: string): SlashCommandOption[] {
  if (!buffer.startsWith("/")) {
    return [];
  }

  const keyword = buffer.slice(1).trim().toLowerCase();
  if (!keyword) {
    return SLASH_COMMANDS;
  }

  return SLASH_COMMANDS.filter((item) => {
    return (
      item.command.toLowerCase().includes(keyword) ||
      item.label.toLowerCase().includes(keyword) ||
      item.description.toLowerCase().includes(keyword)
    );
  });
}

function getHelpText(): string {
  return [
    "/help  查看帮助",
    "/history 打开本轮对话列表，可选择删除部分上下文",
    "/todos 查看当前待办列表",
    "/plan  根据你的下一条输入建立或重写 todo 列表",
    "/sessions 查看已保存会话",
    "/resume 恢复最近一次保存的会话",
    "/stats 查看当前会话统计",
    "/model 切换当前模型",
    "/clear 清空当前会话上下文",
    "/exit  退出",
    "/      打开命令列表，可用方向键选择",
  ].join("\n");
}

function getPickerModels(defaultModelId?: string): ModelSpec[] {
  const featured = FEATURED_MODEL_IDS.map((id) => findModelSpec(id)).filter((model): model is ModelSpec => Boolean(model));
  const defaultModel = defaultModelId ? findModelSpec(defaultModelId) : undefined;

  if (!defaultModel) {
    return featured;
  }

  const exists = featured.some((model) => model.id === defaultModel.id);
  return exists ? featured : [defaultModel, ...featured];
}

function resolveStartupModel(defaultModelId?: string): ModelSpec {
  const models = getPickerModels(defaultModelId);
  if (models.length === 0) {
    throw new Error("没有可用模型");
  }
  return models[0];
}

async function promptModelSelection(currentModelId: string, defaultModelId?: string): Promise<ModelSpec> {
  const models = getPickerModels(defaultModelId);
  if (models.length === 0) {
    throw new Error("没有可用模型");
  }

  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = (await rl.question("model id > ")).trim();
      const selected = (answer ? findModelSpec(answer) : undefined) ?? findModelSpec(currentModelId) ?? models[0];
      return selected;
    } finally {
      rl.close();
    }
  }

  emitKeypressEvents(input);
  input.resume();
  input.setRawMode(true);

  return await new Promise<ModelSpec>((resolve, reject) => {
    let selectedIndex = Math.max(
      models.findIndex((model) => model.id === currentModelId),
      0,
    );
    const prompt = "model > ";

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
    };

    const render = (): void => {
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
      output.write(colorize(prompt, `${ANSI.bright}${ANSI.cyan}`));

      for (let index = 0; index < models.length; index += 1) {
        const model = models[index];
        const selected = index === selectedIndex;
        const marker = selected ? colorize(">", `${ANSI.bright}${ANSI.white}`) : colorize(" ", `${ANSI.dim}${ANSI.gray}`);
        const tags = [
          model.id === currentModelId ? "current" : "",
          model.id === defaultModelId ? "default" : "",
        ]
          .filter(Boolean)
          .join(", ");
        const detail = tags ? `${model.id} (${tags})` : model.id;
        const line = selected ? colorize(detail, `${ANSI.bright}${ANSI.white}`) : colorize(detail, `${ANSI.dim}${ANSI.gray}`);
        output.write(`\n${marker} ${line}`);
      }

      output.write(`\x1b[${models.length}A`);
      cursorTo(output, prompt.length);
    };

    const finalize = (selected: ModelSpec): void => {
      cleanup();
      output.write(`${colorize(prompt, `${ANSI.bright}${ANSI.cyan}`)}${selected.id}\n`);
      resolve(selected);
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("用户中断"));
        return;
      }

      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + models.length) % models.length;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % models.length;
        render();
        return;
      }

      if (key.name === "return") {
        finalize(models[selectedIndex]);
        return;
      }

      if (key.name === "escape") {
        finalize(findModelSpec(currentModelId) ?? models[0]);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

async function promptSessionHistorySelection(state: SessionState): Promise<number> {
  const turns = buildSessionTurns(state.messages);
  if (turns.length === 0) {
    console.log("当前会话还没有可管理的对话。");
    return 0;
  }

  if (!input.isTTY) {
    turns.forEach((entry) => {
      console.log(`${entry.turnNumber}. ${truncateForDisplay(entry.userText, 60)}`);
    });
    return 0;
  }

  emitKeypressEvents(input);
  input.resume();
  input.setRawMode(true);

  return await new Promise<number>((resolve, reject) => {
    let cursorIndex = 0;
    const selectedTurns = new Set<number>();
    const prompt = "history > ";

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
    };

    const render = (): void => {
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
      output.write(colorize(`${prompt}空格勾选，回车删除，Esc 取消`, `${ANSI.bright}${ANSI.cyan}`));

      for (let index = 0; index < turns.length; index += 1) {
        const entry = turns[index];
        const active = index === cursorIndex;
        const checked = selectedTurns.has(entry.turnNumber) ? "[x]" : "[ ]";
        const marker = active ? colorize(">", `${ANSI.bright}${ANSI.white}`) : colorize(" ", `${ANSI.dim}${ANSI.gray}`);
        const summary = `${checked} 第 ${entry.turnNumber} 轮  ${truncateForDisplay(entry.userText, 44)}`;
        const detail = entry.assistantText ? `    ${truncateForDisplay(entry.assistantText, 44)}` : "    (暂无回答)";
        const mainLine = active ? colorize(summary, `${ANSI.bright}${ANSI.white}`) : colorize(summary, `${ANSI.dim}${ANSI.gray}`);
        const subLine = colorize(detail, `${ANSI.dim}${ANSI.gray}`);
        output.write(`\n${marker} ${mainLine}`);
        output.write(`\n  ${subLine}`);
      }

      output.write(`\x1b[${turns.length * 2}A`);
      cursorTo(output, getDisplayWidth(prompt));
    };

    const finish = (applyDelete: boolean): void => {
      cleanup();
      const deleted = applyDelete ? removeSessionTurns(state, [...selectedTurns]) : 0;
      if (applyDelete && deleted > 0) {
        console.log(`已从当前上下文删除 ${deleted} 轮对话。`);
      } else if (applyDelete) {
        console.log("未选择任何对话，保持不变。");
      } else {
        console.log("已取消历史管理。");
      }
      resolve(deleted);
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("用户中断"));
        return;
      }

      if (key.name === "up") {
        cursorIndex = (cursorIndex - 1 + turns.length) % turns.length;
        render();
        return;
      }

      if (key.name === "down") {
        cursorIndex = (cursorIndex + 1) % turns.length;
        render();
        return;
      }

      if (key.name === "space") {
        const currentTurn = turns[cursorIndex]?.turnNumber;
        if (currentTurn) {
          if (selectedTurns.has(currentTurn)) {
            selectedTurns.delete(currentTurn);
          } else {
            selectedTurns.add(currentTurn);
          }
        }
        render();
        return;
      }

      if (key.name === "return") {
        finish(true);
        return;
      }

      if (key.name === "escape") {
        finish(false);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

async function promptInteractiveInput(): Promise<string> {
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question("> ")).trim();
    } finally {
      rl.close();
    }
  }

  emitKeypressEvents(input);
  input.resume();
  input.setRawMode(true);

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let selectedIndex = 0;
    let renderedSuggestionCount = 0;

    const prompt = "> ";

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
    };

    const render = (): void => {
      const suggestions = getFilteredSlashCommands(buffer);
      if (selectedIndex >= suggestions.length) {
        selectedIndex = Math.max(suggestions.length - 1, 0);
      }

      output.write("\r");
      clearLine(output, 0);
      output.write("\x1b[J");
      output.write(`${colorize(prompt, `${ANSI.bright}${ANSI.cyan}`)}${buffer}`);

      for (let index = 0; index < suggestions.length; index += 1) {
        const option = suggestions[index];
        const selected = index === selectedIndex;
        const marker = selected ? colorize(">", `${ANSI.bright}${ANSI.white}`) : colorize(" ", `${ANSI.dim}${ANSI.gray}`);
        const detail = selected
          ? colorize(`${option.command}  ${option.description}`, `${ANSI.bright}${ANSI.white}`)
          : colorize(`${option.command}  ${option.description}`, `${ANSI.dim}${ANSI.gray}`);
        output.write(`\n${marker} ${detail}`);
      }

      renderedSuggestionCount = suggestions.length;
      if (renderedSuggestionCount > 0) {
        output.write(`\x1b[${renderedSuggestionCount}A`);
      }
      cursorTo(output, getDisplayWidth(prompt) + getDisplayWidth(buffer));
    };

    const finalize = (value: string): void => {
      cleanup();
      output.write(`${colorize(prompt, `${ANSI.bright}${ANSI.cyan}`)}${value}\n`);
      resolve(value);
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }): void => {
      const suggestions = getFilteredSlashCommands(buffer);

      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("用户中断"));
        return;
      }

      if (key.name === "return") {
        if (suggestions.length > 0) {
          finalize(suggestions[selectedIndex]?.command ?? buffer.trim());
          return;
        }
        finalize(buffer.trim());
        return;
      }

      if (key.name === "up") {
        if (suggestions.length > 0) {
          selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
          render();
        }
        return;
      }

      if (key.name === "down") {
        if (suggestions.length > 0) {
          selectedIndex = (selectedIndex + 1) % suggestions.length;
          render();
        }
        return;
      }

      if (key.name === "backspace") {
        buffer = buffer.slice(0, -1);
        selectedIndex = 0;
        render();
        return;
      }

      if (key.name === "escape") {
        buffer = "";
        selectedIndex = 0;
        render();
        return;
      }

      if (str && !key.ctrl) {
        buffer += str;
        selectedIndex = 0;
        render();
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

async function handleHistoryCommand(args: string[], options: { interactive?: boolean } = {}): Promise<void> {
  const dataDir = getDataDir();
  await ensureDataDir(dataDir);
  const fail = (message: string): void => {
    console.error(message);
    if (!options.interactive) {
      process.exitCode = 1;
    }
  };

  const subcommand = args[0];

  if (!subcommand) {
    console.log("用法：");
    console.log("  /history list");
    console.log("  /history show <id>");
    console.log("  /history delete <id>");
    return;
  }

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
      fail("请提供历史记录 id，例如：/history show <id>");
      return;
    }

    const item = await getHistoryItem(dataDir, id);
    if (!item) {
      fail(`未找到历史记录：${id}`);
      return;
    }

    console.log(JSON.stringify(item.turn, null, 2));
    return;
  }

  if (subcommand === "delete") {
    const id = args[1];
    if (!id) {
      fail("请提供历史记录 id，例如：/history delete <id>");
      return;
    }

    const deleted = await deleteHistoryItem(dataDir, id);
    if (!deleted) {
      fail(`未找到历史记录：${id}`);
      return;
    }

    console.log(`已删除历史记录：${id}`);
    return;
  }

  console.log("用法：");
  console.log("  /history list");
  console.log("  /history show <id>");
  console.log("  /history delete <id>");
}

async function delegateSubtask(parentState: SessionState, task: string): Promise<string> {
  const config = loadConfig();
  const helperState = createSessionState(parentState.model, `${config.systemPrompt}\nYou are a focused helper agent. Solve only the delegated subtask.`);
  const result = await runAgentTurn(
    config,
    [...helperState.messages, { role: "user", content: task }],
    parentState.model,
    {
      config,
      permission: { mode: "deny" },
      todos: [],
      setTodos: () => undefined,
    },
    undefined,
    await getMemoryContext(config.dataDir, task),
  );
  return result.responseText;
}

async function executeTurn(
  state: SessionState,
  userInput: string,
  options: {
    interactive?: boolean;
    printOnly?: boolean;
  } = {},
): Promise<void> {
  const config = loadConfig();
  state.messages.push({ role: "user", content: userInput });
  const compressed = compressMessages(state.messages, config.contextCharBudget, state.compressedSummary);
  state.messages = compressed.messages;
  state.compressedSummary = compressed.compressedSummary;
  const memoryContext = await getMemoryContext(config.dataDir, userInput);
  let answerStarted = false;
  let streamedAnswer = "";
  let thinkingLineOpen = false;
  const closeThinkingLine = (): void => {
    if (!options.interactive || !thinkingLineOpen) {
      return;
    }
    process.stdout.write("\n");
    thinkingLineOpen = false;
  };
  const updateThinkingLine = (text: string): void => {
    if (!options.interactive || !thinkingLineOpen) {
      return;
    }
    process.stdout.write("\r");
    clearLine(output, 0);
    process.stdout.write(colorize(`  ${text}`, `${ANSI.dim}${ANSI.gray}`));
  };
  if (options.interactive) {
    console.log("");
    printLabel("You", `${ANSI.bright}${ANSI.white}`);
    printTextBlock(userInput);
    printLabel("Thinking", ANSI.yellow);
    process.stdout.write(colorize("  working...", `${ANSI.dim}${ANSI.gray}`));
    thinkingLineOpen = true;
  }

  const result = await runAgentTurn(
    config,
    state.messages,
    state.model,
    {
      config,
      permission: {
        mode: options.interactive ? config.permissionMode : "deny",
        requestApproval: options.interactive ? requestPermissionApproval : undefined,
      },
      todos: state.todos,
      setTodos: (todos) => {
        state.todos = todos;
      },
      delegateTask: async (task) => await delegateSubtask(state, task),
    },
    (event) => {
      if (event.type === "analysis") {
        const preview = toSingleLine(event.text || "");
        updateThinkingLine(preview || "working...");
        return;
      }

      if (event.type === "tool_call") {
        if (options.interactive) {
          closeThinkingLine();
          printLabel("Tool", ANSI.magenta, event.toolName);
        }
        return;
      }

      if (event.type === "tool_result") {
        if (options.interactive) {
          printTextBlock(event.summary, `${ANSI.dim}${ANSI.gray}`);
        }
        return;
      }

      if (event.type === "final") {
        if (options.interactive) {
          closeThinkingLine();
          if (!answerStarted) {
            answerStarted = true;
            printLabel("Assistant", ANSI.cyan);
            process.stdout.write("  ");
          }
          const delta = event.responseText.slice(streamedAnswer.length);
          if (delta) {
            process.stdout.write(delta);
            streamedAnswer = event.responseText;
          }
        }
      }
    },
    memoryContext,
  );

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
    toolTraces: result.toolTraces,
    usage: result.usage,
    cost: result.cost,
  };

  await saveTurn(config.dataDir, turn);

  const safeAssistantReply = result.responseText.trim() || result.analysisText.trim() || "收到。";
  state.messages.push({ role: "assistant", content: safeAssistantReply });
  await persistSessionState(state);

  if (options.printOnly) {
    console.log(safeAssistantReply);
  } else if (options.interactive) {
    closeThinkingLine();
    if (!answerStarted) {
      printLabel("Assistant", ANSI.cyan);
      printTextBlock(safeAssistantReply);
    } else {
      process.stdout.write("\n");
    }
    console.log(colorize(
      `turn in:${result.usage.promptTokens} cache:${result.usage.cachedTokens} out:${result.usage.completionTokens} cost:${formatCny(result.cost.totalCost)}`,
      `${ANSI.dim}${ANSI.gray}`,
    ));
    console.log(colorize(
      `total in:${state.totals.promptTokens} cache:${state.totals.cachedTokens} out:${state.totals.completionTokens} cost:${formatCny(state.totals.totalCost)}`,
      `${ANSI.dim}${ANSI.gray}`,
    ));
    console.log(colorize(
      `history ${turn.id}  response ${result.responseMeta.id ?? "-"}  finish ${result.responseMeta.finishReason ?? "-"}`,
      `${ANSI.dim}${ANSI.gray}`,
    ));
    if (state.todos.length > 0) {
      console.log(colorize(`todos ${state.todos.length}  use /todos 查看`, `${ANSI.dim}${ANSI.gray}`));
    }
    console.log(colorize(
      "".padEnd(Math.max(48, Math.min(process.stdout.columns ?? 100, 84)), "-"),
      `${ANSI.dim}${ANSI.gray}`,
    ));
  } else {
    printRule();
    console.log(`[用户] ${userInput}`);
    console.log(`[思考] ${result.analysisText || "已完成"}`);
    for (const trace of result.toolTraces) {
      console.log(`[工具] ${trace.name}`);
      console.log(`  ${trace.resultSummary}`);
    }
    console.log(`[回答] ${safeAssistantReply}`);
    console.log(
      `本轮  输入:${result.usage.promptTokens} 缓存:${result.usage.cachedTokens} 输出:${result.usage.completionTokens} ${formatCny(result.cost.totalCost)}  |  累计  输入:${state.totals.promptTokens} 缓存:${state.totals.cachedTokens} 输出:${state.totals.completionTokens} ${formatCny(state.totals.totalCost)}`,
    );
    console.log(`meta  history_id:${turn.id}  response_id:${result.responseMeta.id ?? "-"}  finish_reason:${result.responseMeta.finishReason ?? "-"}`);
    printRule();
  }
}

async function runSinglePrompt(prompt: string, options: { printOnly?: boolean; sessionId?: string } = {}): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  let state: SessionState;
  if (options.sessionId) {
    const snapshot = await getSessionSnapshot(config.dataDir, options.sessionId);
    const model = findModelSpec(snapshot?.model ?? "") ?? resolveStartupModel(config.defaultModel);
    state = snapshot ? restoreSessionState(snapshot, model) : createSessionState(model, config.systemPrompt);
  } else {
    const model = resolveStartupModel(config.defaultModel);
    state = createSessionState(model, config.systemPrompt);
  }

  if (!options.printOnly) {
    printSessionHeader(state.model);
  }
  await executeTurn(state, prompt, { printOnly: options.printOnly });
  if (!options.printOnly) {
    printSessionSummary(state.totals);
  }
}

async function runInteractive(): Promise<void> {
  const config = loadConfig();
  await ensureDataDir(config.dataDir);

  let state: SessionState | undefined;
  try {
    let model = resolveStartupModel(config.defaultModel);
    input.resume();

    state = createSessionState(model, config.systemPrompt);
    await persistSessionState(state);
    printSessionHeader(model);
    console.log("输入消息开始对话。");
    printRule();

    while (true) {
      const userInput = await promptInteractiveInput();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      if (userInput === "/help") {
        printDivider("Commands");
        console.log(getHelpText());
        continue;
      }

      if (userInput === "/history") {
        printDivider("History");
        await promptSessionHistorySelection(state);
        await persistSessionState(state);
        printRule();
        continue;
      }

      if (userInput === "/todos") {
        printDivider("Todos");
        printTodoList(state.todos);
        printRule();
        continue;
      }

      if (userInput === "/sessions") {
        printDivider("Sessions");
        const sessions = await listSessionSnapshots(config.dataDir);
        for (const item of sessions.slice(0, 10)) {
          console.log(`${item.sessionId}  ${item.session.model}  ${item.session.updatedAt}  ${item.session.summary}`);
        }
        printRule();
        continue;
      }

      if (userInput === "/resume") {
        const snapshot = await promptSessionResumeSelection(state.sessionId);
        if (snapshot) {
          const resumedModel = findModelSpec(snapshot.model) ?? resolveStartupModel(config.defaultModel);
          model = resumedModel;
          state = restoreSessionState(snapshot, resumedModel);
          printSessionHeader(resumedModel);
          console.log(`已恢复会话 ${snapshot.sessionId}。`);
          if (state.todos.length > 0) {
            console.log(`已恢复 ${state.todos.length} 个待办项。`);
          }
          printRule();
        }
        continue;
      }

      if (userInput === "/stats") {
        console.log(
          `累计统计  turns:${state.turnCount}  messages:${state.messages.length - 1}  todos:${state.todos.length}  total_tokens:${state.totals.totalTokens}  total_cost:${formatCny(state.totals.totalCost)}`,
        );
        continue;
      }

      if (userInput === "/model") {
        const nextModel = await promptModelSelection(state.model.id, config.defaultModel);
        if (nextModel.id !== state.model.id) {
          model = nextModel;
          state = createSessionState(nextModel, config.systemPrompt);
          await persistSessionState(state);
          printSessionHeader(nextModel);
          console.log(`已切换到模型 ${nextModel.id}，并重置当前上下文。`);
          printRule();
        } else {
          console.log(`保持当前模型 ${state.model.id}。`);
        }
        continue;
      }

      if (userInput === "/clear") {
        state = createSessionState(state.model, config.systemPrompt);
        await persistSessionState(state);
        console.log("上下文已清空。");
        printRule();
        continue;
      }

      if (userInput === "/plan") {
        const rl = readline.createInterface({ input, output });
        try {
          const goal = (await rl.question("plan > ")).trim();
          if (!goal) {
            console.log("未提供规划目标。");
            continue;
          }
          await executeTurn(state, `请为这个目标建立一个简洁的任务计划，并优先使用 todo_write 工具更新待办列表：${goal}`, {
            interactive: true,
          });
        } finally {
          rl.close();
        }
        continue;
      }

      if (userInput.startsWith("!")) {
        await executeTurn(state, `请直接执行这个命令并解释结果：${userInput.slice(1).trim()}`, {
          interactive: true,
        });
        continue;
      }

      await executeTurn(state, userInput, {
        interactive: true,
      });
    }
  } finally {
    if (state) {
      printSessionSummary(state.totals);
    }
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

  if (command === "resume") {
    const config = loadConfig();
    const sessionId = rest[0] ?? (await listSessionSnapshots(config.dataDir))[0]?.sessionId;
    if (!sessionId) {
      console.error("没有可恢复的会话。");
      process.exitCode = 1;
      return;
    }
    await runSinglePrompt("继续当前工作，并先简要总结当前上下文。", { sessionId });
    return;
  }

  if (command === "sessions") {
    const config = loadConfig();
    const sessions = await listSessionSnapshots(config.dataDir);
    for (const item of sessions) {
      console.log(`${item.sessionId} | ${item.session.updatedAt} | ${item.session.model} | ${item.session.summary}`);
    }
    return;
  }

  if (command === "--print" || command === "-p" || command === "print") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      console.error("请提供要输出的 prompt，例如：xilonagent --print 帮我概括这个目录");
      process.exitCode = 1;
      return;
    }
    await runSinglePrompt(prompt, { printOnly: true });
    return;
  }

  if (command === "feishu") {
    await runFeishuBridge();
    return;
  }

  await runInteractive();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`运行失败：${message}`);
  process.exitCode = 1;
});
