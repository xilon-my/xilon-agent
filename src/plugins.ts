import fs from "node:fs/promises";
import path from "node:path";

export interface PluginToolDefinition {
  name: string;
  description: string;
  command: string;
  readOnly?: boolean;
}

interface PluginManifest {
  tools?: PluginToolDefinition[];
}

export async function loadPluginTools(pluginDir: string): Promise<PluginToolDefinition[]> {
  try {
    const entries = await fs.readdir(pluginDir);
    const tools: PluginToolDefinition[] = [];

    for (const entry of entries.filter((item) => item.endsWith(".json"))) {
      const filePath = path.join(pluginDir, entry);
      const raw = await fs.readFile(filePath, "utf8");
      const manifest = JSON.parse(raw) as PluginManifest;
      for (const tool of manifest.tools ?? []) {
        if (!tool.name || !tool.description || !tool.command) {
          continue;
        }
        tools.push(tool);
      }
    }

    return tools;
  } catch {
    return [];
  }
}
