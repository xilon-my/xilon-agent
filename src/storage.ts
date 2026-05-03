import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, SessionSnapshot, TurnRecord } from "./types.js";

function getHistoryDir(dataDir: string): string {
  return path.join(dataDir, "history");
}

function getSessionsDir(dataDir: string): string {
  return path.join(dataDir, "sessions");
}

function getMemoryDir(dataDir: string): string {
  return path.join(dataDir, "memory");
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await Promise.all([
    fs.mkdir(getHistoryDir(dataDir), { recursive: true }),
    fs.mkdir(getSessionsDir(dataDir), { recursive: true }),
    fs.mkdir(getMemoryDir(dataDir), { recursive: true }),
  ]);
}

export async function saveTurn(dataDir: string, turn: TurnRecord): Promise<string> {
  await ensureDataDir(dataDir);
  const fileName = `${turn.createdAt.replace(/[:.]/g, "-")}__${turn.id}.json`;
  const filePath = path.join(getHistoryDir(dataDir), fileName);

  await fs.writeFile(filePath, `${JSON.stringify(turn, null, 2)}\n`, "utf8");
  return filePath;
}

export async function listHistory(dataDir: string): Promise<Array<{ id: string; filePath: string; turn: TurnRecord }>> {
  await ensureDataDir(dataDir);
  const dir = getHistoryDir(dataDir);
  const files = await fs.readdir(dir);
  const result: Array<{ id: string; filePath: string; turn: TurnRecord }> = [];

  for (const file of files.filter((entry) => entry.endsWith(".json")).sort().reverse()) {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, "utf8");
    const turn = JSON.parse(content) as TurnRecord;
    result.push({ id: turn.id, filePath, turn });
  }

  return result;
}

export async function getHistoryItem(
  dataDir: string,
  id: string,
): Promise<{ filePath: string; turn: TurnRecord } | null> {
  const items = await listHistory(dataDir);
  const matched = items.find((item) => item.id === id);
  if (!matched) {
    return null;
  }
  return { filePath: matched.filePath, turn: matched.turn };
}

export async function deleteHistoryItem(dataDir: string, id: string): Promise<boolean> {
  const item = await getHistoryItem(dataDir, id);
  if (!item) {
    return false;
  }

  await fs.unlink(item.filePath);
  return true;
}

export async function saveSessionSnapshot(dataDir: string, session: SessionSnapshot): Promise<string> {
  await ensureDataDir(dataDir);
  const filePath = path.join(getSessionsDir(dataDir), `${session.sessionId}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return filePath;
}

export async function listSessionSnapshots(
  dataDir: string,
): Promise<Array<{ sessionId: string; filePath: string; session: SessionSnapshot }>> {
  await ensureDataDir(dataDir);
  const dir = getSessionsDir(dataDir);
  const files = await fs.readdir(dir);
  const result: Array<{ sessionId: string; filePath: string; session: SessionSnapshot }> = [];

  for (const file of files.filter((entry) => entry.endsWith(".json")).sort().reverse()) {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, "utf8");
    const session = JSON.parse(content) as SessionSnapshot;
    result.push({ sessionId: session.sessionId, filePath, session });
  }

  return result.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
}

export async function getSessionSnapshot(dataDir: string, sessionId: string): Promise<SessionSnapshot | null> {
  await ensureDataDir(dataDir);
  const filePath = path.join(getSessionsDir(dataDir), `${sessionId}.json`);
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as SessionSnapshot;
  } catch {
    return null;
  }
}

function getMemoryPath(dataDir: string): string {
  return path.join(getMemoryDir(dataDir), "entries.json");
}

export async function listMemoryEntries(dataDir: string): Promise<MemoryEntry[]> {
  await ensureDataDir(dataDir);
  try {
    const content = await fs.readFile(getMemoryPath(dataDir), "utf8");
    const entries = JSON.parse(content) as MemoryEntry[];
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

async function saveMemoryEntries(dataDir: string, entries: MemoryEntry[]): Promise<void> {
  await ensureDataDir(dataDir);
  await fs.writeFile(getMemoryPath(dataDir), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

export async function addMemoryEntry(
  dataDir: string,
  input: Omit<MemoryEntry, "id" | "updatedAt" | "lastUsedAt">,
): Promise<MemoryEntry> {
  const entries = await listMemoryEntries(dataDir);
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: randomUUID().slice(0, 8),
    title: input.title,
    content: input.content,
    scope: input.scope,
    updatedAt: now,
    lastUsedAt: now,
  };
  entries.unshift(entry);
  await saveMemoryEntries(dataDir, entries.slice(0, 100));
  return entry;
}

export async function touchMemoryEntries(dataDir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  const entries = await listMemoryEntries(dataDir);
  const next = entries.map((entry) => (ids.includes(entry.id) ? { ...entry, lastUsedAt: now } : entry));
  await saveMemoryEntries(dataDir, next);
}
