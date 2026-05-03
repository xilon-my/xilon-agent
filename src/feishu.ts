import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { compressMessages } from "./context.js";
import { loadConfig } from "./config.js";
import { formatCny } from "./cost.js";
import { getMemoryContext } from "./memory.js";
import { findModelSpec, FEATURED_MODEL_IDS } from "./models.js";
import { runAgentTurn } from "./agent.js";
import {
  getSessionSnapshot,
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

interface FeishuSessionState {
  sessionId: string;
  createdAt: string;
  model: ModelSpec;
  messages: ChatMessage[];
  totals: SessionTotals;
  todos: TodoItem[];
  compressedSummary?: string;
}

interface FeishuSendTarget {
  chatId: string;
  chatType: string;
  replyToMessageId?: string;
}

interface FeishuEventPayload {
  header?: {
    event_id?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<unknown>;
  };
  sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
    };
  };
  event?: {
    sender?: {
      sender_type?: string;
      sender_id?: {
        open_id?: string;
      };
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: Array<unknown>;
    };
  };
}

const eventLocks = new Map<string, Promise<void>>();
const processedEventIds = new Map<string, number>();
const processedMessageIds = new Map<string, number>();
const FEISHU_FILE_SEND_PROMPT =
  "You are currently replying inside Feishu chat. If the user asks you to send, forward, deliver, or share a local file, use `send_local_file` with the file path instead of trying to read the file as plain text.";

export async function runFeishuBridge(): Promise<void> {
  const config = loadConfig();
  const feishu = config.feishu;
  if (!feishu) {
    throw new Error("缺少飞书配置，请设置 XILON_FEISHU_APP_ID 与 XILON_FEISHU_APP_SECRET");
  }
  const baseConfig = {
    appId: feishu.appId,
    appSecret: feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  };
  const wsClient = new Lark.WSClient(baseConfig);
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      const payload = data as FeishuEventPayload;
      const eventId = payload.header?.event_id;
      if (eventId && isDuplicateEvent(eventId)) {
        return;
      }
      await handleFeishuEvent(payload);
    },
  });
  wsClient.start({ eventDispatcher });
  console.log("Feishu bridge running in long-connection mode.");
  console.log("请在飞书后台选择“长连接接收事件”，无需配置公网回调地址。");
}

async function handleFeishuEvent(payload: FeishuEventPayload): Promise<void> {
  const config = loadConfig();
  if (!config.feishu) {
    return;
  }

  const event = payload.event ?? payload;
  const message = event?.message ?? payload.message;
  const sender = event?.sender ?? payload.sender;
  if (!message || !sender) {
    return;
  }

  const messageId = message.message_id ?? "";
  if (messageId && isDuplicateMessage(messageId)) {
    return;
  }

  if (sender.sender_type !== "user") {
    return;
  }

  if (message.message_type !== "text") {
    await sendFeishuText(config, message.chat_id ?? "", "当前只支持文本消息。");
    return;
  }

  if (message.chat_type !== "p2p" && !(message.mentions?.length)) {
    return;
  }

  const text = extractFeishuText(message.content ?? "");
  if (!text) {
    return;
  }

  const key = buildFeishuSessionKey(message.chat_type ?? "p2p", message.chat_id ?? "", sender.sender_id?.open_id ?? "");
  await withSessionLock(key, async () => {
    const reply = await processFeishuText(key, text, {
      chatId: message.chat_id ?? "",
      chatType: message.chat_type ?? "p2p",
      replyToMessageId: message.message_id ?? "",
    }).catch((error: unknown) => {
      const messageText = formatFeishuBridgeError(error);
      console.error(`[feishu] 消息处理失败: ${messageText}`);
      return messageText;
    });
    try {
      await sendFeishuText(config, message.chat_id ?? "", reply, message.message_id ?? "", message.chat_type ?? "p2p");
    } catch (error) {
      const messageText = formatFeishuBridgeError(error);
      console.error(`[feishu] 发送消息失败: ${messageText}`);
    }
  });
}

async function processFeishuText(sessionKey: string, text: string, sendTarget: FeishuSendTarget): Promise<string> {
  const config = loadConfig();
  const feishu = config.feishu;
  if (!feishu) {
    throw new Error("飞书配置缺失");
  }
  const model = resolveFeishuModel(config.defaultModel);
  let state = await loadFeishuSessionState(sessionKey, model, config.systemPrompt);
  ensureFeishuTransportPrompt(state);

  if (text === "/clear") {
    state = createFeishuSessionState(sessionKey, model, config.systemPrompt);
    await persistFeishuSessionState(state);
    return "已清空当前飞书会话上下文。";
  }

  if (text === "/stats") {
    return [
      `模型: ${state.model.id}`,
      `turns: ${Math.max(0, Math.floor((state.messages.length - 1) / 2))}`,
      `todos: ${state.todos.length}`,
      `tokens: ${state.totals.totalTokens}`,
      `cost: ${formatCny(state.totals.totalCost)}`,
    ].join("\n");
  }

  if (text === "/todos") {
    if (state.todos.length === 0) {
      return "当前没有待办项。";
    }
    return state.todos
      .map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.content}`)
      .join("\n");
  }

  if (text.startsWith("/model ")) {
    const nextModel = findModelSpec(text.slice("/model ".length).trim());
    if (!nextModel) {
      return "未找到指定模型。";
    }
    state = createFeishuSessionState(sessionKey, nextModel, config.systemPrompt);
    await persistFeishuSessionState(state);
    return `已切换到模型 ${nextModel.id}，并重置当前飞书会话。`;
  }

  state.messages.push({ role: "user", content: text });
  const compressed = compressMessages(state.messages, config.contextCharBudget, state.compressedSummary);
  state.messages = compressed.messages;
  state.compressedSummary = compressed.compressedSummary;
  const memoryContext = await getMemoryContext(config.dataDir, text);

  const result = await runAgentTurn(
    config,
    state.messages,
    state.model,
    {
      config,
      permission: { mode: feishu.permissionMode },
      todos: state.todos,
      setTodos: (todos) => {
        state.todos = todos;
      },
      sendLocalFile: async (filePath) => sendFeishuLocalFile(config, sendTarget, filePath),
    },
    undefined,
    memoryContext,
  );

  addUsage(state.totals, result.usage, result.cost);
  const safeReply = result.responseText.trim() || result.analysisText.trim() || "收到。";
  state.messages.push({ role: "assistant", content: safeReply });
  await saveTurn(
    config.dataDir,
    createTurnRecord(state, config.baseURL, text, result),
  );
  await persistFeishuSessionState(state);
  return truncateMessage(safeReply);
}

async function loadFeishuSessionState(sessionId: string, model: ModelSpec, systemPrompt: string): Promise<FeishuSessionState> {
  const config = loadConfig();
  const snapshot = await getSessionSnapshot(config.dataDir, sessionId);
  if (!snapshot) {
    return createFeishuSessionState(sessionId, model, systemPrompt);
  }

  return {
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt,
    model: findModelSpec(snapshot.model) ?? model,
    messages: snapshot.messages,
    totals: snapshot.totals,
    todos: snapshot.todos ?? [],
    compressedSummary: snapshot.compressedSummary,
  };
}

function createFeishuSessionState(sessionId: string, model: ModelSpec, systemPrompt: string): FeishuSessionState {
  return {
    sessionId,
    createdAt: new Date().toISOString(),
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: FEISHU_FILE_SEND_PROMPT,
      },
    ],
    totals: createEmptyTotals(),
    todos: [],
  };
}

function ensureFeishuTransportPrompt(state: FeishuSessionState): void {
  const exists = state.messages.some((message) => message.role === "system" && message.content === FEISHU_FILE_SEND_PROMPT);
  if (!exists) {
    state.messages.splice(1, 0, { role: "system", content: FEISHU_FILE_SEND_PROMPT });
  }
}

async function persistFeishuSessionState(state: FeishuSessionState): Promise<void> {
  const config = loadConfig();
  const snapshot: SessionSnapshot = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    model: state.model.id,
    summary: summarizeSession(state.messages),
    messages: state.messages,
    totals: state.totals,
    todos: state.todos,
    compressedSummary: state.compressedSummary,
  };
  await saveSessionSnapshot(config.dataDir, snapshot);
}

async function sendFeishuText(
  config: ReturnType<typeof loadConfig>,
  chatId: string,
  text: string,
  replyToMessageId?: string,
  chatType = "p2p",
): Promise<void> {
  if (!config.feishu || !chatId) {
    return;
  }
  const client = new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });
  if (chatType === "p2p") {
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: truncateMessage(text) }),
      },
    });
    return;
  }

  if (replyToMessageId) {
    await client.im.v1.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: truncateMessage(text) }),
      },
    });
  }
}

async function sendFeishuLocalFile(
  config: ReturnType<typeof loadConfig>,
  target: FeishuSendTarget,
  filePath: string,
): Promise<string> {
  if (!config.feishu) {
    throw new Error("飞书配置缺失");
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`目标不是普通文件: ${filePath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`文件为空，无法发送: ${filePath}`);
  }
  if (stat.size > 30 * 1024 * 1024) {
    throw new Error(`文件超过飞书上传上限 30MB: ${filePath}`);
  }

  const client = new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });
  const fileName = path.basename(filePath);
  const fileType = resolveFeishuUploadFileType(filePath);
  const fileBuffer = await fs.readFile(filePath);
  const upload = await client.im.v1.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file: fileBuffer,
    },
  });
  const fileKey = upload?.file_key;
  if (!fileKey) {
    throw new Error(`飞书文件上传失败: ${filePath}`);
  }

  const content = JSON.stringify({ file_key: fileKey });
  if (target.chatType === "p2p") {
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: target.chatId,
        msg_type: "file",
        content,
      },
    });
  } else if (target.replyToMessageId) {
    await client.im.v1.message.reply({
      path: { message_id: target.replyToMessageId },
      data: {
        msg_type: "file",
        content,
      },
    });
  } else {
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: target.chatId,
        msg_type: "file",
        content,
      },
    });
  }

  return `已发送文件: ${fileName}`;
}

function resolveFeishuModel(defaultModelId?: string): ModelSpec {
  return findModelSpec(defaultModelId ?? "") ?? findModelSpec(FEATURED_MODEL_IDS[0])!;
}

function buildFeishuSessionKey(chatType: string, chatId: string, openId: string): string {
  const raw = chatType === "p2p" ? `feishu:p2p:${openId || chatId}` : `feishu:chat:${chatId}`;
  return `feishu_${Buffer.from(raw).toString("base64url")}`;
}

async function withSessionLock(key: string, task: () => Promise<void>): Promise<void> {
  const current = eventLocks.get(key) ?? Promise.resolve();
  const next = current.then(task, task);
  eventLocks.set(key, next.finally(() => {
    if (eventLocks.get(key) === next) {
      eventLocks.delete(key);
    }
  }));
  await next;
}

function extractFeishuText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return (parsed.text ?? "").trim();
  } catch {
    return content.trim();
  }
}

function truncateMessage(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= 3000) {
    return normalized;
  }
  return `${normalized.slice(0, 3000)}\n\n[内容已截断]`;
}

function resolveFeishuUploadFileType(filePath: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".opus") {
    return "opus";
  }
  if (ext === ".mp4") {
    return "mp4";
  }
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".doc" || ext === ".docx") {
    return "doc";
  }
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") {
    return "xls";
  }
  if (ext === ".ppt" || ext === ".pptx") {
    return "ppt";
  }
  return "stream";
}

function summarizeSession(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "飞书会话";
  return lastUser.replace(/\s+/g, " ").trim().slice(0, 80) || "飞书会话";
}

function createTurnRecord(
  state: FeishuSessionState,
  baseURL: string,
  userInput: string,
  result: {
    analysisText: string;
    responseText: string;
    toolTraces: TurnRecord["toolTraces"];
    usage: UsageSummary;
    cost: CostSummary;
    responseMeta: { id?: string; finishReason?: string | null };
  },
): TurnRecord {
  return {
    id: randomUUID().slice(0, 8),
    sessionId: state.sessionId,
    createdAt: new Date().toISOString(),
    model: state.model.id,
    baseURL,
    requestMessages: [...state.messages, { role: "user", content: userInput }],
    thinkingText: result.analysisText,
    responseText: result.responseText,
    toolTraces: result.toolTraces,
    usage: result.usage,
    cost: result.cost,
  };
}

function addUsage(totals: SessionTotals, usage: UsageSummary, cost: CostSummary): void {
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
  totals.cachedTokens += usage.cachedTokens;
  totals.totalCost += cost.totalCost;
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

function formatFeishuBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid Authentication|401/i.test(message)) {
    return "模型鉴权失败：请检查 `.env` 里的 `XILON_API_KEY` 是否已填写真实可用的模型 API Key。";
  }
  if (/99991672|im:message:send|im:message:send_as_bot/i.test(message)) {
    return "飞书应用缺少消息发送权限：请在飞书开放平台为应用开通 `im:message:send`、`im:message` 或 `im:message:send_as_bot` 中至少一个权限。";
  }
  return `处理消息时发生错误：${message}`;
}

function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();
  for (const [key, timestamp] of processedEventIds) {
    if (now - timestamp > 10 * 60_000) {
      processedEventIds.delete(key);
    }
  }
  if (processedEventIds.has(eventId)) {
    return true;
  }
  processedEventIds.set(eventId, now);
  return false;
}

function isDuplicateMessage(messageId: string): boolean {
  const now = Date.now();
  for (const [key, timestamp] of processedMessageIds) {
    if (now - timestamp > 10 * 60_000) {
      processedMessageIds.delete(key);
    }
  }
  if (processedMessageIds.has(messageId)) {
    return true;
  }
  processedMessageIds.set(messageId, now);
  return false;
}
