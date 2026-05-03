import { formatCny } from "./cost.js";
import { formatContextWindow } from "./models.js";
import type { CostSummary, ModelSpec, UsageSummary } from "./types.js";

export interface TranscriptEntry {
  role: "user" | "thinking" | "assistant";
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
  gray: "\u001b[90m",
  white: "\u001b[37m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
};

function colorize(value: string, color: string): string {
  return `${color}${value}${ANSI.reset}`;
}

function getScreenWidth(): number {
  const width = process.stdout.columns ?? 100;
  return Math.max(72, Math.min(width, 140));
}

function getScreenHeight(): number {
  const height = process.stdout.rows ?? 30;
  return Math.max(20, height);
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
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

function padAnsi(text: string, width: number): string {
  const length = visibleLength(text);
  if (length >= width) {
    return text;
  }
  return `${text}${" ".repeat(width - length)}`;
}

function centerAnsi(text: string, width: number, fill = "-"): string {
  const length = visibleLength(text);
  if (length >= width) {
    return text;
  }

  const rest = width - length;
  const left = Math.floor(rest / 2);
  const right = rest - left;
  return `${fill.repeat(left)}${text}${fill.repeat(right)}`;
}

function formatRate(value: number): string {
  return `¥${value.toFixed(2)}/M`;
}

function renderHeader(title: string, width: number): string[] {
  const decorated = colorize(` ${title} `, `${ANSI.bright}${ANSI.white}`);
  return [centerAnsi(decorated, width)];
}

function renderMetaPanel(model: ModelSpec, turnCount: number, totalCost: number, width: number): string[] {
  const innerWidth = width - 4;
  const lines = [
    `模型  ${model.id}`,
    `价格  输入 ${formatRate(model.inputPricePerMTok)} · 输出 ${formatRate(model.outputPricePerMTok)} · 缓存 ${formatRate(model.cacheHitPricePerMTok)}`,
    `窗口  ${formatContextWindow(model.contextWindow)} · 回合 ${turnCount} · 累计 ${formatCny(totalCost)}`,
  ];

  const rendered = [
    `+${"-".repeat(width - 2)}+`,
    ...lines.flatMap((line) => wrapLine(line, innerWidth).map((item) => `| ${padAnsi(item, innerWidth)} |`)),
    `+${"-".repeat(width - 2)}+`,
  ];

  return rendered;
}

function renderDivider(width: number): string {
  return colorize("-".repeat(width), ANSI.gray);
}

function renderTranscript(entries: TranscriptEntry[], width: number): string[] {
  if (entries.length === 0) {
    return [colorize("等待你的第一条消息...", `${ANSI.dim}${ANSI.gray}`)];
  }

  const lines: string[] = [];
  for (const entry of entries.slice(-10)) {
    const prefix =
      entry.role === "user"
        ? "[User] "
        : entry.role === "thinking"
          ? "[Thinking] "
          : "[Answer] ";
    const color =
      entry.role === "user"
        ? `${ANSI.bright}${ANSI.white}`
        : entry.role === "thinking"
          ? ANSI.yellow
          : ANSI.gray;
    const text = entry.content || (entry.role === "assistant" ? "..." : entry.role === "thinking" ? "..." : "");
    const wrapped = wrapLine(text, Math.max(width - prefix.length, 12));

    wrapped.forEach((line, index) => {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(colorize(`${label}${line}`, color));
    });
  }

  return lines;
}

function fitLinesToHeightBottom(lines: string[], height: number): string[] {
  if (height <= 0) {
    return [];
  }

  if (lines.length >= height) {
    return lines.slice(lines.length - height);
  }

  const padding = Array.from({ length: height - lines.length }, () => "");
  return [...padding, ...lines];
}

export function renderInteractiveScreen(state: ScreenState): void {
  const width = getScreenWidth();
  const height = getScreenHeight();
  const transcript = renderTranscript(trimPendingAssistant(state.transcript), width);
  const stats: string[] = [];

  if (state.lastUsage && state.lastCost) {
    stats.push(
      colorize(
        `本轮  输入:${state.lastUsage.promptTokens} 缓存:${state.lastUsage.cachedTokens} 输出:${state.lastUsage.completionTokens} ${formatCny(state.lastCost.totalCost)}`,
        ANSI.green,
      ),
    );
  }

  stats.push(
    colorize(
      `累计  输入:${state.totalUsage.promptTokens} 缓存:${state.totalUsage.cachedTokens} 输出:${state.totalUsage.completionTokens} ${formatCny(state.totalCost.totalCost)}`,
      ANSI.green,
    ),
  );
  stats.push(colorize("命令  /help  /stats  /model  /clear  /exit", `${ANSI.dim}${ANSI.gray}`));

  const footer = state.footerLines?.length
    ? ["", ...state.footerLines.map((line) => colorize(line, `${ANSI.dim}${ANSI.gray}`))]
    : [];

  const header = renderHeader(state.title, width);
  const metaPanel = renderMetaPanel(state.model, state.turnCount, state.totalCost.totalCost, width);
  const topSection = [...header, ...metaPanel, "", renderDivider(width), ""];
  const bottomSection = ["", renderDivider(width), ...stats, ...footer];
  const transcriptHeight = Math.max(height - topSection.length - bottomSection.length - 2, 6);
  const fittedTranscript = fitLinesToHeightBottom(transcript, transcriptHeight);

  const screen = [
    ...topSection,
    ...fittedTranscript,
    ...bottomSection,
  ].join("\n");

  process.stdout.write("\u001b[2J\u001b[H");
  process.stdout.write(`${screen}\n`);
}

export function renderModelPickerScreen(options: {
  title: string;
  models: ModelSpec[];
  defaultModelId?: string;
  message?: string;
}): void {
  const width = getScreenWidth();
  const lines = options.models.map((model, index) => {
    const defaultTag = model.id === options.defaultModelId ? " [default]" : "";
    return `${index + 1}. ${model.id}${defaultTag} | in ${formatRate(model.inputPricePerMTok)} | out ${formatRate(model.outputPricePerMTok)} | cache ${formatRate(model.cacheHitPricePerMTok)} | ctx ${formatContextWindow(model.contextWindow)}`;
  });

  const screen = [
    ...renderHeader(options.title, width),
    `+${"-".repeat(width - 2)}+`,
    `| ${padAnsi(colorize("Select Model", `${ANSI.bright}${ANSI.white}`), width - 4)} |`,
    ...lines.flatMap((line) => wrapLine(line, width - 4).map((item) => `| ${padAnsi(item, width - 4)} |`)),
    `+${"-".repeat(width - 2)}+`,
    "",
    colorize("输入模型序号后回车，直接回车使用默认模型。", `${ANSI.dim}${ANSI.gray}`),
    ...(options.message ? [colorize(options.message, ANSI.yellow)] : []),
  ].join("\n");

  process.stdout.write("\u001b[2J\u001b[H");
  process.stdout.write(`${screen}\n`);
}

function trimPendingAssistant(entries: TranscriptEntry[]): TranscriptEntry[] {
  if (entries.length === 0) {
    return entries;
  }

  const cloned = [...entries];
  return cloned;
}
