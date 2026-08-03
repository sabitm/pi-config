import type { OcCompactConfig } from "./types";

const PRUNE_MARKER = "[tool output pruned by oc-compact]";

export const isPruneMarker = (text: string): boolean => text.includes(PRUNE_MARKER);

/** Truncate tool-result text; keeps the start (OpenCode-style). */
export const truncateForSummary = (text: string, maxChars: number): string => {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
};

const contentParts = (content: unknown): any[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" ? { ...p } : p));
  return [];
};

const partsToText = (parts: any[]): string =>
  parts
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "image") return `[Attached ${p.mimeType ?? "image"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

/**
 * Strip images and truncate tool results on head messages before summarization.
 * Returns a shallow-cloned message list; does not mutate inputs.
 * Session JSONL is never touched (invariant).
 */
export const prepareHeadMessages = (
  messages: any[],
  config: Pick<OcCompactConfig, "toolOutputMaxChars" | "stripMedia">,
): { messages: any[]; mediaStripped: number } => {
  let mediaStripped = 0;

  const mapContent = (content: unknown, truncate: boolean): unknown => {
    const parts = contentParts(content);
    const next: any[] = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") {
        next.push(part);
        continue;
      }
      if (part.type === "image") {
        if (config.stripMedia) {
          mediaStripped += 1;
          next.push({
            type: "text",
            text: `[Attached ${part.mimeType ?? "image"}]`,
          });
        } else {
          next.push(part);
        }
        continue;
      }
      if (part.type === "text" && typeof part.text === "string" && truncate) {
        next.push({ ...part, text: truncateForSummary(part.text, config.toolOutputMaxChars) });
        continue;
      }
      next.push(part);
    }
    // Preserve string content shape when input was a plain string and no images.
    if (typeof content === "string" && next.length === 1 && next[0]?.type === "text") {
      return next[0].text;
    }
    return next;
  };

  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role === "toolResult") {
      return { ...msg, content: mapContent(msg.content, true) };
    }
    if (msg.role === "user" || msg.role === "custom") {
      return { ...msg, content: mapContent(msg.content, false) };
    }
    if (msg.role === "bashExecution" && typeof msg.output === "string") {
      return {
        ...msg,
        output: truncateForSummary(msg.output, config.toolOutputMaxChars),
      };
    }
    return msg;
  });

  return { messages: out, mediaStripped };
};

/**
 * OpenCode-style text serialization of head messages (debug / provider fallback).
 */
export const serializeHead = (messages: any[]): string => {
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    switch (msg.role) {
      case "user": {
        const text = partsToText(contentParts(msg.content)).trim();
        if (text) parts.push(`[User]: ${text}`);
        break;
      }
      case "assistant": {
        const thinking: string[] = [];
        const toolCalls: string[] = [];
        const texts: string[] = [];
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "thinking" && block.thinking) thinking.push(String(block.thinking));
          if (block.type === "text" && block.text) texts.push(String(block.text));
          if (block.type === "toolCall") {
            const input = block.arguments ?? block.input ?? {};
            const args =
              typeof input === "string" ? input : JSON.stringify(input);
            toolCalls.push(`${block.name}(${args})`);
          }
        }
        if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
        if (texts.length) parts.push(`[Assistant]: ${texts.join("\n")}`);
        for (const tc of toolCalls) parts.push(`[Assistant tool call]: ${tc}`);
        break;
      }
      case "toolResult": {
        const text = partsToText(contentParts(msg.content)).trim();
        if (msg.isError) parts.push(`[Tool error]: ${text}`);
        else if (text) parts.push(`[Tool result]: ${text}`);
        break;
      }
      case "bashExecution": {
        parts.push(`[Shell]: ${msg.command ?? ""}\n${msg.output ?? ""}`);
        break;
      }
      case "branchSummary":
      case "compactionSummary": {
        if (msg.summary) parts.push(`[${msg.role === "branchSummary" ? "Branch summary" : "Compaction summary"}]: ${msg.summary}`);
        break;
      }
      case "custom": {
        const text = partsToText(contentParts(msg.content)).trim();
        if (text) parts.push(`[Custom]: ${text}`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n\n");
};

export { PRUNE_MARKER };
