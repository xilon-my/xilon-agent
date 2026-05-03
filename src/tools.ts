import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AppConfig } from "./config.js";
import type { PermissionRuntime } from "./permissions.js";
import { requireToolPermission } from "./permissions.js";
import { loadPluginTools } from "./plugins.js";
import { addMemoryEntry, listMemoryEntries, listSessionSnapshots } from "./storage.js";
import type { TodoItem } from "./types.js";

const execAsync = promisify(exec);
const MAX_OUTPUT_LENGTH = 6000;
const MAX_FILE_SIZE = 5_000_000;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_MATCHES = 120;
const KNOWN_BINARY_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
]);

export interface ToolTrace {
  name: string;
  argumentsText: string;
  resultSummary: string;
  outputPreview: string;
}

interface ToolExecutionResult {
  content: string;
  summary: string;
}

export interface ToolExecutionContext {
  config: AppConfig;
  permission: PermissionRuntime;
  todos: TodoItem[];
  setTodos: (todos: TodoItem[]) => void;
  delegateTask?: (task: string) => Promise<string>;
  sendLocalFile?: (filePath: string) => Promise<string>;
}

const BUILTIN_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_cwd",
      description: "Get current working directory for this CLI session. This is only the default starting folder, not a filesystem limit.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_drives",
      description: "List available filesystem roots or drive letters on the local machine. Use this first when you need to explore the whole computer on Windows.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a path anywhere on the local machine. Use absolute paths like C:\\, D:\\, or E:\\ when you need to explore outside the current project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path. Defaults to current working directory, but absolute paths can point anywhere on the computer." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_search",
      description: "Find files by wildcard pattern like src/*.ts or **/*.md under any local path. Use an absolute path to search outside the current project.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob-like wildcard pattern." },
          path: { type: "string", description: "Directory to search from. Can be any absolute local path." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Search file contents by text or regular expression under any local path. Use an absolute path to search outside the current project.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Literal text or regex pattern to search." },
          path: { type: "string", description: "Directory to search from. Can be any absolute local path." },
          regex: { type: "boolean", description: "When true, treat pattern as JavaScript regular expression." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file anywhere on the local machine. Do not use this on directories; use list_files for folders. Absolute paths are allowed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path. Absolute paths can point anywhere on the local machine." },
          start_line: { type: "number", description: "Optional 1-based start line." },
          end_line: { type: "number", description: "Optional 1-based end line." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_local_file",
      description: "Send a local file directly to the current chat when the user asks you to send, deliver, forward, or share a file. Use this instead of read_file for non-text files or when the user wants the actual file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative local file path to send." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file with full content anywhere on the local machine, subject to permissions.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path. Absolute paths can point anywhere on the local machine." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit an existing text file anywhere on the local machine by replacing one string with another, subject to permissions.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path. Absolute paths can point anywhere on the local machine." },
          find: { type: "string", description: "Existing text to replace." },
          replace: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace all matches instead of the first one." },
        },
        required: ["path", "find", "replace"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a PowerShell command on the local machine. By default it runs in the current working directory, but it can be pointed at another absolute directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "PowerShell command to run." },
          cwd: { type: "string", description: "Optional absolute or relative working directory for the command." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Create or update the session todo list. Always keep at most one in_progress task.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["id", "content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a stable reusable memory for future sessions.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          scope: { type: "string", enum: ["project", "user"] },
        },
        required: ["title", "content", "scope"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description: "List saved long-term memories.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "List resumable saved sessions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Delegate a subtask to a lightweight helper agent and return a concise summary.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Focused subtask to delegate." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
  },
];

export async function getAgentTools(config: AppConfig): Promise<ChatCompletionTool[]> {
  const pluginTools = await loadPluginTools(config.pluginDir);
  const pluginSchemas: ChatCompletionTool[] = pluginTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description} (plugin tool)`,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Plugin input text." },
        },
        required: ["input"],
        additionalProperties: false,
      },
    },
  }));

  return [...BUILTIN_TOOLS, ...pluginSchemas];
}

export async function executeToolCall(
  toolName: string,
  rawArguments: string,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    const parsedArgs = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
    const pluginTools = await loadPluginTools(context.config.pluginDir);
    const pluginTool = pluginTools.find((tool) => tool.name === toolName);
    if (pluginTool) {
      return await executePluginTool(pluginTool, parsedArgs.input, context);
    }

    switch (toolName) {
      case "get_cwd":
        return await executeGetCwd();
      case "list_drives":
        return await executeListDrives();
      case "list_files":
        return await executeListFiles(parsedArgs.path);
      case "glob_search":
        return await executeGlobSearch(parsedArgs.pattern, parsedArgs.path);
      case "grep_files":
        return await executeGrepFiles(parsedArgs.pattern, parsedArgs.path, parsedArgs.regex);
      case "read_file":
        return await executeReadFile(parsedArgs.path, parsedArgs.start_line, parsedArgs.end_line);
      case "send_local_file":
        return await executeSendLocalFile(parsedArgs.path, context);
      case "write_file":
        return await executeWriteFile(parsedArgs.path, parsedArgs.content, context);
      case "edit_file":
        return await executeEditFile(parsedArgs.path, parsedArgs.find, parsedArgs.replace, parsedArgs.replace_all, context);
      case "run_command":
        return await executeRunCommand(parsedArgs.command, parsedArgs.cwd, context);
      case "todo_write":
        return executeTodoWrite(parsedArgs.todos, context);
      case "save_memory":
        return await executeSaveMemory(parsedArgs.title, parsedArgs.content, parsedArgs.scope, context);
      case "list_memories":
        return await executeListMemories(context);
      case "list_sessions":
        return await executeListSessions(context);
      case "delegate_task":
        return await executeDelegateTask(parsedArgs.task, context);
      default:
        throw new Error(`Unsupported tool: ${toolName}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Tool error: ${message}`,
      summary: `工具执行失败: ${message}`,
    };
  }
}

function resolvePath(inputPath?: unknown): string {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return process.cwd();
  }
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function executeGetCwd(): Promise<ToolExecutionResult> {
  const cwd = process.cwd();
  return { content: cwd, summary: `当前工作目录: ${cwd}` };
}

async function executeListDrives(): Promise<ToolExecutionResult> {
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      try {
        await fs.access(drive);
        drives.push(drive);
      } catch {
        continue;
      }
    }
    return {
      content: drives.join("\n") || "(no drives found)",
      summary: `发现 ${drives.length} 个可访问磁盘根目录`,
    };
  }

  return {
    content: "/",
    summary: "当前系统根目录为 /",
  };
}

async function executeListFiles(inputPath?: unknown): Promise<ToolExecutionResult> {
  const targetPath = resolvePath(inputPath);
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`);
  return {
    content: lines.join("\n"),
    summary: `列出 ${targetPath} 下 ${entries.length} 项`,
  };
}

async function executeGlobSearch(patternValue: unknown, inputPath?: unknown): Promise<ToolExecutionResult> {
  const pattern = ensureString(patternValue, "pattern");
  const basePath = resolvePath(inputPath);
  const regex = wildcardToRegExp(pattern);
  const scan = await collectFiles(basePath, {
    maxFiles: MAX_SEARCH_FILES,
    match: (file) => regex.test(normalizeForMatch(path.relative(basePath, file))),
  });
  const matches = scan.matches;
  return {
    content: truncate(matches.join("\n") || "(no matches)"),
    summary: `按模式 ${pattern} 找到 ${matches.length} 个文件${scan.truncated ? "（搜索范围已截断）" : ""}`,
  };
}

async function executeGrepFiles(patternValue: unknown, inputPath?: unknown, regexValue?: unknown): Promise<ToolExecutionResult> {
  const pattern = ensureString(patternValue, "pattern");
  const basePath = resolvePath(inputPath);
  const matcher = typeof regexValue === "boolean" && regexValue ? new RegExp(pattern, "i") : pattern.toLowerCase();
  const matches: string[] = [];
  const scan = await collectFiles(basePath, { maxFiles: MAX_SEARCH_FILES });

  for (const file of scan.files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const hit = typeof matcher === "string" ? line.toLowerCase().includes(matcher) : matcher.test(line);
        if (hit) {
          matches.push(`${file}:${index + 1}: ${line.trim()}`);
          if (matches.length >= MAX_SEARCH_MATCHES) {
            break;
          }
        }
      }
      if (matches.length >= MAX_SEARCH_MATCHES) {
        break;
      }
    } catch {
      continue;
    }
  }

  return {
    content: truncate(matches.join("\n") || "(no matches)"),
    summary: `搜索 ${pattern} 命中 ${matches.length} 行${scan.truncated ? "（搜索范围已截断）" : ""}`,
  };
}

async function executeReadFile(inputPath?: unknown, startLineValue?: unknown, endLineValue?: unknown): Promise<ToolExecutionResult> {
  const targetPath = resolvePath(ensureString(inputPath, "path"));
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${targetPath}. Use list_files instead.`);
  }
  if (isLikelyBinaryPath(targetPath)) {
    throw new Error(`Path is a binary or document file that cannot be read as plain text: ${targetPath}`);
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File is too large to read safely as plain text (${stat.size} bytes): ${targetPath}`);
  }

  const raw = await fs.readFile(targetPath);
  if (looksBinary(raw)) {
    throw new Error(`Path appears to be a binary file and cannot be read as plain text: ${targetPath}`);
  }
  const content = raw.toString("utf8");
  const lines = content.split("\n");
  const startLine = typeof startLineValue === "number" && startLineValue > 0 ? startLineValue : 1;
  const endLine = typeof endLineValue === "number" && endLineValue >= startLine ? endLineValue : lines.length;
  const sliced = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}→${line}`);
  return {
    content: truncate(sliced.join("\n")),
    summary: `读取文件: ${targetPath}${startLine !== 1 || endLine !== lines.length ? ` (${startLine}-${endLine})` : ""}`,
  };
}

async function executeSendLocalFile(inputPath: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const targetPath = resolvePath(ensureString(inputPath, "path"));
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory and cannot be sent as a file: ${targetPath}`);
  }
  if (!context.sendLocalFile) {
    throw new Error(`Current runtime does not support sending local files: ${targetPath}`);
  }
  await requireToolPermission(context.permission, {
    toolName: "send_local_file",
    summary: `发送文件 ${targetPath}`,
  });
  const result = await context.sendLocalFile(targetPath);
  return {
    content: result,
    summary: result,
  };
}

async function executeWriteFile(inputPath: unknown, contentValue: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const targetPath = resolvePath(ensureString(inputPath, "path"));
  const content = typeof contentValue === "string" ? contentValue : "";
  await requireToolPermission(context.permission, {
    toolName: "write_file",
    summary: `写入文件 ${targetPath}`,
  });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  return {
    content: truncate(content),
    summary: `已写入文件: ${targetPath}`,
  };
}

async function executeEditFile(
  inputPath: unknown,
  findValue: unknown,
  replaceValue: unknown,
  replaceAllValue: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const targetPath = resolvePath(ensureString(inputPath, "path"));
  const find = ensureString(findValue, "find");
  const replace = typeof replaceValue === "string" ? replaceValue : "";
  const replaceAll = Boolean(replaceAllValue);
  await requireToolPermission(context.permission, {
    toolName: "edit_file",
    summary: `修改文件 ${targetPath}`,
  });

  const original = await fs.readFile(targetPath, "utf8");
  if (!original.includes(find)) {
    throw new Error(`目标文件中未找到指定片段: ${targetPath}`);
  }
  const next = replaceAll ? original.split(find).join(replace) : original.replace(find, replace);
  await fs.writeFile(targetPath, next, "utf8");
  return {
    content: truncate(next),
    summary: `已修改文件: ${targetPath}`,
  };
}

async function executeRunCommand(commandValue?: unknown, cwdValue?: unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
  const command = ensureString(commandValue, "command");
  const targetCwd = typeof cwdValue === "string" && cwdValue.trim() ? resolvePath(cwdValue) : process.cwd();
  await requireToolPermission(context?.permission, {
    toolName: "run_command",
    summary: `执行命令 ${command}${targetCwd !== process.cwd() ? ` (cwd: ${targetCwd})` : ""}`,
    command,
  });

  const { stdout, stderr } = await execAsync(command, {
    cwd: targetCwd,
    shell: "powershell.exe",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });

  const merged = [stdout, stderr].filter(Boolean).join("\n").trim();
  return {
    content: truncate(merged || "(no output)"),
    summary: `执行命令: ${command}${targetCwd !== process.cwd() ? ` (cwd: ${targetCwd})` : ""}`,
  };
}

function executeTodoWrite(todosValue: unknown, context: ToolExecutionContext): ToolExecutionResult {
  if (!Array.isArray(todosValue)) {
    throw new Error("todos must be an array");
  }

  const now = new Date().toISOString();
  const todos = todosValue.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      id: ensureString(record.id, "todo id"),
      content: ensureString(record.content, "todo content"),
      status: ensureString(record.status, "todo status") as TodoItem["status"],
      updatedAt: now,
    };
  });
  context.setTodos(todos);
  return {
    content: JSON.stringify(todos, null, 2),
    summary: `已更新 ${todos.length} 个待办项`,
  };
}

async function executeSaveMemory(
  titleValue: unknown,
  contentValue: unknown,
  scopeValue: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const title = ensureString(titleValue, "title");
  const content = ensureString(contentValue, "content");
  const scope = scopeValue === "user" ? "user" : "project";
  const entry = await addMemoryEntry(context.config.dataDir, { title, content, scope });
  return {
    content: JSON.stringify(entry, null, 2),
    summary: `已写入长期记忆: ${title}`,
  };
}

async function executeListMemories(context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const entries = await listMemoryEntries(context.config.dataDir);
  const lines = entries.map((entry) => `${entry.id} | ${entry.scope} | ${entry.title} | ${entry.content}`);
  return {
    content: truncate(lines.join("\n") || "(no memories)"),
    summary: `当前共有 ${entries.length} 条长期记忆`,
  };
}

async function executeListSessions(context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const sessions = await listSessionSnapshots(context.config.dataDir);
  const lines = sessions.map(
    (item) => `${item.sessionId} | ${item.session.updatedAt} | ${item.session.model} | ${item.session.summary}`,
  );
  return {
    content: truncate(lines.join("\n") || "(no sessions)"),
    summary: `当前共有 ${sessions.length} 个可恢复会话`,
  };
}

async function executeDelegateTask(taskValue: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const task = ensureString(taskValue, "task");
  if (!context.delegateTask) {
    throw new Error("当前运行环境不支持子任务代理");
  }
  const result = await context.delegateTask(task);
  return {
    content: truncate(result),
    summary: `已委托子任务: ${task}`,
  };
}

async function executePluginTool(
  plugin: { name: string; command: string; readOnly?: boolean },
  inputValue: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!plugin.readOnly) {
    await requireToolPermission(context.permission, {
      toolName: plugin.name,
      summary: `执行插件工具 ${plugin.name}`,
    });
  }

  const inputText = typeof inputValue === "string" ? inputValue : "";
  const command = plugin.command
    .replace(/\{\{input\}\}/g, inputText)
    .replace(/\{\{cwd\}\}/g, process.cwd());
  const { stdout, stderr } = await execAsync(command, {
    cwd: process.cwd(),
    shell: "powershell.exe",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  const merged = [stdout, stderr].filter(Boolean).join("\n").trim();
  return {
    content: truncate(merged || "(no output)"),
    summary: `执行插件工具: ${plugin.name}`,
  };
}

async function collectFiles(
  basePath: string,
  options?: {
    maxFiles?: number;
    match?: (file: string) => boolean;
  },
): Promise<{ files: string[]; matches: string[]; truncated: boolean }> {
  const maxFiles = options?.maxFiles ?? MAX_SEARCH_FILES;
  const files: string[] = [];
  const matches: string[] = [];
  const queue = [basePath];
  let truncated = false;

  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      files.push(fullPath);
      if (options?.match?.(fullPath)) {
        matches.push(fullPath);
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, matches, truncated };
      }
    }
  }

  return { files, matches, truncated };
}

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, "/");
}

function wildcardToRegExp(pattern: string): RegExp {
  const normalized = normalizeForMatch(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${normalized}$`, "i");
}

function isLikelyBinaryPath(filePath: string): boolean {
  return KNOWN_BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) {
    return false;
  }
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if ((byte < 7 || (byte > 14 && byte < 32)) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length > 0.1;
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_LENGTH)}\n...<truncated>`;
}
