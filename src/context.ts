import type { ChatMessage } from "./types.js";

export interface CompressionResult {
  messages: ChatMessage[];
  compressedSummary?: string;
}

export function compressMessages(
  messages: ChatMessage[],
  budget: number,
  previousSummary?: string,
): CompressionResult {
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars <= budget || messages.length <= 10) {
    return {
      messages,
      compressedSummary: previousSummary,
    };
  }

  const systemMessage = messages[0];
  const recentMessages = messages.slice(-8);
  const oldMessages = messages.slice(1, -8);
  const summaryParts: string[] = [];

  if (previousSummary?.trim()) {
    summaryParts.push(`Earlier summary:\n${previousSummary.trim()}`);
  }

  const oldLines = oldMessages.map((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    const snippet = message.content.replace(/\s+/g, " ").trim().slice(0, 240);
    return `- ${role}: ${snippet}`;
  });

  if (oldLines.length > 0) {
    summaryParts.push(`Compressed session context:\n${oldLines.join("\n")}`);
  }

  const compressedSummary = summaryParts.join("\n\n").trim();
  const summaryMessage: ChatMessage | undefined = compressedSummary
    ? {
        role: "system",
        content: [
          "Use the following compressed context as prior conversation memory.",
          "Do not repeat it verbatim unless needed.",
          compressedSummary,
        ].join("\n\n"),
      }
    : undefined;

  return {
    messages: [systemMessage, ...(summaryMessage ? [summaryMessage] : []), ...recentMessages],
    compressedSummary,
  };
}
