import fs from "node:fs/promises";
import path from "node:path";
import type { TurnRecord } from "./types.js";

function getHistoryDir(dataDir: string): string {
  return path.join(dataDir, "history");
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await fs.mkdir(getHistoryDir(dataDir), { recursive: true });
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
