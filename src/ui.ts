import { formatCny } from "./cost.js";
import { formatContextWindow } from "./models.js";
import type { CostSummary, ModelSpec, UsageSummary } from "./types.js";

export interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
}

export interface ScreenState {
  title: string;
  model: ModelSpec;
  transcript: TranscriptEntry[];
  turnCount: number;
  totalUsage: UsageSummary;
  totalCost: CostSummary;
  lastUsage?: UsageSummary;
  lastCost?: CostSummary;
  footerLines?: string[];
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bright: "\u001b[1m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
};

function colorize(value: string, color: string): string {
  return `${color}${value}${ANSI.reset}`;
}

function getScreenWidth(): number {
  const width = process.stdout.columns ?? 100;
  return Math.max(72, Math.min(width, 140));
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    lines.push(remaining);
  }

  return lines;
}

function padRight(text: string, width: number): string {
  if (text.length >= width) {
    return text.slice(0, width);
  }
  return `${text}${" ".repeat(width - text.length)}`;
}

function renderPanel(title: string, lines: string[], width: number): string[] {
  const innerWidth = width - 4;
  const topBorder = `+${"-".repeat(width - 2)}+`;
  const titleText = ` ${title} `;
  const titleStart = Math.max(Math.floor((width - titleText.length) / 2), 1);
  const titledTop =
    `+${"-".repeat(Math.max(titleStart - 1, 0))}${titleText}${"-".repeat(Math.max(width - titleStart - titleText.length - 1, 0))}+`;

  const body = lines.flatMap((line) => {
    return wrapLine(line, innerWidth).map((wrapped) => `| ${padRight(wrapped, innerWidth)} |`);
  });

  return [title ? titledTop : topBorder, ...body, topBorder];
}

function renderTranscript(entries: TranscriptEntry[], width: number): string[] {
  if (entries.length === 0) {
    return [colorize("等待你的第一条消息...", ANSI.dim)];
  }

  const lines: string[] = [];
  for (const entry of entries.slice(-12)) {
    const prefix = entry.role === "user" ? ">> " : "[AI] ";
    const color = entry.role === "user" ? ANSI.yellow : ANSI.cyan;
    const content = entry.content || (entry.role === "assistant" ? "..." : "");
    const wrapped = wrapLine(content, width - prefix.length);
    wrapped.forEach((line, index) => {
      const linePrefix = index === 0 ? prefix : "   ";
      lines.push(colorize(`${linePrefix}${line}`, color));
    });
    lines.push("");
  }

  return lines.slice(0, -1);
}

function formatRate(value: number): string {
  return `¥${value.toFixed(2)}/1M`;
}

export function renderInteractiveScreen(state: ScreenState): void {
  const width = getScreenWidth();
  const panel = renderPanel(
    state.title,
    [
      `模型   ${state.model.id}`,
      `价格   输入 ${formatRate(state.model.inputPricePerMTok)} | 输出 ${formatRate(state.model.outputPricePerMTok)} | 缓存 ${formatRate(state.model.cacheHitPricePerMTok)}`,
      `上下文 ${formatContextWindow(state.model.contextWindow)} | 回合 ${state.turnCount} | 累计 ${formatCny(state.totalCost.totalCost)}`,
      "命令   /help  /stats  /model  /clear  /exit",
    ],
    width,
  );

  const transcript = renderTranscript(entriesWithoutEmptyTail(state.transcript), width);
  const statLines: string[] = [];

  if (state.lastUsage && state.lastCost) {
    statLines.push(
      colorize(
        `本轮  输入:${state.lastUsage.promptTokens} 缓存:${state.lastUsage.cachedTokens} 输出:${state.lastUsage.completionTokens} ${formatCny(state.lastCost.totalCost)}`,
        ANSI.green,
      ),
    );
  }

  statLines.push(
    colorize(
      `累计  输入:${state.totalUsage.promptTokens} 缓存:${state.totalUsage.cachedTokens} 输出:${state.totalUsage.completionTokens} ${formatCny(state.totalCost.totalCost)}`,
      ANSI.green,
    ),
  );

  const footer = state.footerLines?.length
    ? ["", ...state.footerLines.map((line) => colorize(line, ANSI.dim))]
    : [];

  const output = [...panel, "", ...transcript, "", ...statLines, ...footer].join("\n");
  process.stdout.write("\u001b[2J\u001b[H");
  process.stdout.write(`${output}\n`);
}

function entriesWithoutEmptyTail(entries: TranscriptEntry[]): TranscriptEntry[] {
  if (entries.length === 0) {
    return entries;
  }

  const cloned = [...entries];
  while (cloned.length > 0) {
    const last = cloned[cloned.length - 1];
    if (last.role === "assistant" && last.content === "") {
      break;
    }
    return cloned;
  }
  return cloned;
}
