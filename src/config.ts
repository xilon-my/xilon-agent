import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./types.js";

dotenv.config({ quiet: true });

function getRequired(name: string, fallback?: string): string {
  const value = process.env[name] ?? (fallback ? process.env[fallback] : undefined);
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export interface AppConfig {
  apiKey: string;
  baseURL: string;
  systemPrompt: string;
  defaultModel?: string;
  dataDir: string;
  permissionMode: PermissionMode;
  contextCharBudget: number;
  pluginDir: string;
}

export function getDataDir(): string {
  return process.env.XILON_DATA_DIR ?? path.join(os.homedir(), ".xilon-agent");
}

function getPermissionMode(): PermissionMode {
  const value = (process.env.XILON_PERMISSION_MODE ?? "ask").toLowerCase();
  if (value === "allow" || value === "deny" || value === "ask") {
    return value;
  }
  return "ask";
}

export function loadConfig(): AppConfig {
  const dataDir = getDataDir();
  return {
    apiKey: getRequired("XILON_API_KEY", "OPENAI_API_KEY"),
    baseURL: process.env.XILON_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.moonshot.cn/v1",
    systemPrompt: process.env.XILON_SYSTEM_PROMPT ?? "You are a helpful CLI assistant.",
    defaultModel: process.env.XILON_DEFAULT_MODEL,
    dataDir,
    permissionMode: getPermissionMode(),
    contextCharBudget: Number(process.env.XILON_CONTEXT_CHAR_BUDGET ?? "20000"),
    pluginDir: process.env.XILON_PLUGIN_DIR ?? path.join(dataDir, "plugins"),
  };
}
