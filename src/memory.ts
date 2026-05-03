import { listMemoryEntries, touchMemoryEntries } from "./storage.js";

export async function getMemoryContext(dataDir: string, query: string, limit = 4): Promise<string> {
  const entries = await listMemoryEntries(dataDir);
  if (entries.length === 0) {
    return "";
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = entries
    .map((entry) => {
      const haystack = `${entry.title} ${entry.content}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, limit);

  if (ranked.length === 0) {
    return "";
  }

  await touchMemoryEntries(dataDir, ranked.map((item) => item.entry.id));

  return ranked
    .map((item) => `- ${item.entry.title}: ${item.entry.content}`)
    .join("\n");
}
