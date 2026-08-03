import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { OcCompactConfig } from "./types";
import { isPruneMarker, PRUNE_MARKER } from "./serialize";

const contentTextOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && p.type === "text" ? String(p.text ?? "") : ""))
    .join("\n");
};

const isProtectedTool = (toolName: unknown, protectedTools: string[]): boolean =>
  typeof toolName === "string" && protectedTools.includes(toolName);

/**
 * Ephemeral OpenCode-style tool-output prune for the live LLM context.
 * Does not mutate the session JSONL (invariant).
 */
export function pruneToolResults(
  messages: any[],
  config: Pick<
    OcCompactConfig,
    "prune" | "pruneProtectTokens" | "pruneMinimumTokens" | "pruneTailTurns" | "pruneProtectedTools"
  >,
): { messages: any[]; prunedCount: number; prunedTokensEst: number } {
  if (!config.prune || messages.length === 0) {
    return { messages, prunedCount: 0, prunedTokensEst: 0 };
  }

  let total = 0;
  let prunedTokens = 0;
  const toPrune: number[] = [];
  let turns = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "user") {
      turns += 1;
      continue;
    }
    // Protect recent turns (OpenCode: turns < 2).
    if (turns < config.pruneTailTurns) continue;

    // Stop at previous compaction boundary.
    if (msg.role === "compactionSummary") break;

    if (msg.role !== "toolResult") continue;
    if (msg.isError) continue;
    if (isProtectedTool(msg.toolName, config.pruneProtectedTools)) continue;

    const text = contentTextOf(msg.content);
    if (isPruneMarker(text)) continue;

    const est = estimateTokens(msg);
    total += est;
    if (total <= config.pruneProtectTokens) continue;
    prunedTokens += est;
    toPrune.push(i);
  }

  if (prunedTokens <= config.pruneMinimumTokens || toPrune.length === 0) {
    return { messages, prunedCount: 0, prunedTokensEst: 0 };
  }

  const next = messages.slice();
  for (const idx of toPrune) {
    const msg = next[idx];
    next[idx] = {
      ...msg,
      content: [{ type: "text", text: PRUNE_MARKER }],
    };
  }

  return {
    messages: next,
    prunedCount: toPrune.length,
    prunedTokensEst: prunedTokens,
  };
}

/**
 * Replace image parts on the last user message (overflow media strip).
 * Clears after one application when `once` matching succeeds.
 */
export function stripOverflowMedia(messages: any[]): {
  messages: any[];
  stripped: number;
} {
  if (messages.length === 0) return { messages, stripped: 0 };

  // Find last user message
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return { messages, stripped: 0 };

  const msg = messages[userIdx];
  const content = msg.content;
  if (!Array.isArray(content)) return { messages, stripped: 0 };

  let stripped = 0;
  const nextContent = content.map((part: any) => {
    if (part && typeof part === "object" && part.type === "image") {
      stripped += 1;
      return {
        type: "text",
        text: `[Attached ${part.mimeType ?? "image"} omitted after overflow]`,
      };
    }
    return part;
  });

  if (stripped === 0) return { messages, stripped: 0 };

  const next = messages.slice();
  next[userIdx] = { ...msg, content: nextContent };
  return { messages: next, stripped };
}
