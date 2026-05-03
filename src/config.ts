import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

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
}

export function getDataDir(): string {
  return path.join(os.homedir(), ".xilon-agent");
}

export function loadConfig(): AppConfig {
  return {
    apiKey: getRequired("XILON_API_KEY", "OPENAI_API_KEY"),
    baseURL: process.env.XILON_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.moonshot.cn/v1",
    systemPrompt: process.env.XILON_SYSTEM_PROMPT ?? "You are a helpful CLI assistant.",
    defaultModel: process.env.XILON_DEFAULT_MODEL,
    dataDir: getDataDir(),
  };
}
