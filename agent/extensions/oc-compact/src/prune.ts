import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { OcCompactConfig, PruneTrigger } from "./types";
import { isPruneMarker, PRUNE_MARKER } from "./serialize";

export type { PruneTrigger };

export interface PruneEngagementInput {
  trigger: PruneTrigger;
  ratio: number | null;
  contextWindow: number | null;
  reserveTokens: number;
  contextEstimate: number;
  engaged: boolean;
}

export function shouldPruneThisRequest(input: PruneEngagementInput): boolean {
  if (input.trigger === "always") return true;
  // Unknown window: fail safe to legacy always-prune rather than silently never pruning.
  if (input.contextWindow == null || input.contextWindow <= 0) return true;
  // Latch first so a post-prune estimate cannot flip the session back to unpruned history.
  if (input.engaged) return true;
  const threshold =
    input.ratio != null
      ? input.contextWindow * input.ratio
      : input.contextWindow - Math.max(0, input.reserveTokens);
  return input.contextEstimate > threshold;
}

const calculateContextTokensLocal = (usage: any): number => {
  if (!usage || typeof usage !== "object") return 0;
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
};

const lastValidAssistantUsage = (messages: any[]): { usage: any; index: number } | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !msg.usage) continue;
    if (msg.stopReason === "aborted" || msg.stopReason === "error") continue;
    const tokens = calculateContextTokensLocal(msg.usage);
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
      return { usage: msg.usage, index: i };
    }
  }
  return undefined;
};

export function estimateContextTokensLocal(messages: any[]): number {
  const usageInfo = lastValidAssistantUsage(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return estimated;
  }
  let trailing = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailing += estimateTokens(messages[i]);
  }
  return calculateContextTokensLocal(usageInfo.usage) + trailing;
}

const contentTextOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && p.type === "text" ? String(p.text ?? "") : ""))
    .join("\n");
};

const isProtectedTool = (toolName: unknown, protectedTools: string[]): boolean =>
  typeof toolName === "string" && protectedTools.includes(toolName);

export type PruneConfig = Pick<
  OcCompactConfig,
  "prune" | "pruneProtectTokens" | "pruneMinimumTokens" | "pruneTailTurns" | "pruneProtectedTools"
>;

export interface PruneCandidate {
  index: number;
  tokens: number;
  /** User-turn distance from the end (0 = newest user turn's tools). */
  turnsFromEnd: number;
}

/**
 * Eligible successful tool-result outputs, newest-first.
 * Errors, protected tools, markers, and pre-compaction history are excluded.
 */
export function collectPruneCandidates(
  messages: any[],
  protectedTools: string[],
): PruneCandidate[] {
  const candidates: PruneCandidate[] = [];
  let turns = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "user") {
      turns += 1;
      continue;
    }
    if (msg.role === "compactionSummary") break;
    if (msg.role !== "toolResult") continue;
    if (msg.isError) continue;
    if (isProtectedTool(msg.toolName, protectedTools)) continue;

    const text = contentTextOf(msg.content);
    if (isPruneMarker(text)) continue;

    candidates.push({
      index: i,
      tokens: estimateTokens(msg),
      turnsFromEnd: turns,
    });
  }

  return candidates;
}

/**
 * Choose prune indices under a global newest-protect budget.
 * pruneTailTurns is a soft preference: recent-turn outputs claim the protect
 * budget first (already true via newest-first walk), but never an unlimited skip.
 */
export function selectPruneIndices(
  candidatesNewestFirst: PruneCandidate[],
  protectTokens: number,
  minimumTokens: number,
  pruneTailTurns: number,
): { toPrune: number[]; prunedTokensEst: number } {
  let protectedBudgetUsed = 0;
  const toPrune: number[] = [];
  let prunedTokensEst = 0;

  // Allocate the finite protection budget to configured recent turns first.
  const ordered = [
    ...candidatesNewestFirst.filter((c) => c.turnsFromEnd < pruneTailTurns),
    ...candidatesNewestFirst.filter((c) => c.turnsFromEnd >= pruneTailTurns),
  ];

  for (const c of ordered) {
    if (protectedBudgetUsed < protectTokens) {
      // Tool results are atomic, so the result crossing the boundary is protected in full.
      protectedBudgetUsed += c.tokens;
      continue;
    }
    toPrune.push(c.index);
    prunedTokensEst += c.tokens;
  }

  if (prunedTokensEst <= minimumTokens || toPrune.length === 0) {
    return { toPrune: [], prunedTokensEst: 0 };
  }
  return { toPrune, prunedTokensEst };
}

/**
 * Estimate how many tool-result tokens prune would free on these messages.
 * Used when host context usage still reflects unpruned persisted content.
 */
export function estimatePruneSavings(messages: any[], config: PruneConfig): number {
  if (!config.prune || messages.length === 0) return 0;
  const candidates = collectPruneCandidates(messages, config.pruneProtectedTools);
  const { prunedTokensEst } = selectPruneIndices(
    candidates,
    config.pruneProtectTokens,
    config.pruneMinimumTokens,
    config.pruneTailTurns,
  );
  return prunedTokensEst;
}

/**
 * Ephemeral OpenCode-style tool-output prune for the live LLM context.
 * Does not mutate the session JSONL (invariant).
 *
 * Protects the newest pruneProtectTokens of eligible successful tool output
 * globally (including inside a single huge user turn). Older eligible output
 * may be pruned even when pruneTailTurns would have exempted the whole turn.
 */
export function pruneToolResults(
  messages: any[],
  config: PruneConfig,
): { messages: any[]; prunedCount: number; prunedTokensEst: number } {
  if (!config.prune || messages.length === 0) {
    return { messages, prunedCount: 0, prunedTokensEst: 0 };
  }

  const candidates = collectPruneCandidates(messages, config.pruneProtectedTools);
  const { toPrune, prunedTokensEst } = selectPruneIndices(
    candidates,
    config.pruneProtectTokens,
    config.pruneMinimumTokens,
    config.pruneTailTurns,
  );

  if (toPrune.length === 0) {
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
    prunedTokensEst,
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
