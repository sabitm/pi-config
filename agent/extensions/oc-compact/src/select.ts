import { estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { CompactionReason, OcCompactConfig, SelectionResult } from "./types";

const MIN_PRESERVE = 2_000;
const MAX_PRESERVE = 8_000;

export interface SelectTailInput {
  branchEntries: any[];
  config: OcCompactConfig;
  contextWindow: number;
  reason?: CompactionReason;
  previousSummary?: string;
}

type Turn = { start: number; end: number; id: string };

const isTurnStartMessage = (message: any): boolean => {
  switch (message?.role) {
    case "user":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    default:
      return false;
  }
};

const isCutPointMessage = (message: any): boolean => {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    case "toolResult":
      return false;
    default:
      return false;
  }
};

const entryMessages = (entry: any): any[] => {
  try {
    return sessionEntryToContextMessages(entry) ?? [];
  } catch {
    if (entry?.type === "message" && entry.message) return [entry.message];
    return [];
  }
};

const entryTokenEstimate = (entry: any): number =>
  entryMessages(entry).reduce((sum, m) => sum + estimateTokens(m), 0);

const isTurnStartEntry = (entry: any): boolean => {
  if (entry?.type === "compaction") return false;
  return entryMessages(entry).some(isTurnStartMessage);
};

const isValidCutEntry = (entry: any): boolean => {
  if (!entry?.id) return false;
  if (entry.type === "compaction") return false;
  return entryMessages(entry).some(isCutPointMessage);
};

export const preserveRecentBudget = (
  config: OcCompactConfig,
  contextWindow: number,
): number => {
  if (config.preserveRecentTokens != null) {
    return Math.max(0, config.preserveRecentTokens);
  }
  const usable = Math.max(0, contextWindow - config.reserveTokens);
  return Math.min(MAX_PRESERVE, Math.max(MIN_PRESERVE, Math.floor(usable * 0.25)));
};

const findBoundaryStart = (entries: any[]): { boundaryStart: number; previousSummary?: string } => {
  let prevCompactionIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }
  if (prevCompactionIndex < 0) return { boundaryStart: 0 };

  const prev = entries[prevCompactionIndex];
  const previousSummary = typeof prev.summary === "string" ? prev.summary : undefined;
  const keptId = prev.firstKeptEntryId;
  if (keptId) {
    const idx = entries.findIndex((e) => e?.id === keptId);
    if (idx >= 0) return { boundaryStart: idx, previousSummary };
  }
  return { boundaryStart: prevCompactionIndex + 1, previousSummary };
};

const buildTurns = (entries: any[], boundaryStart: number): Turn[] => {
  const turns: Turn[] = [];
  for (let i = boundaryStart; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type === "compaction") continue;
    if (!isTurnStartEntry(entry)) continue;
    turns.push({ start: i, end: entries.length, id: entry.id });
  }
  for (let i = 0; i < turns.length - 1; i++) {
    turns[i].end = turns[i + 1].start;
  }
  return turns;
};

const rangeTokens = (entries: any[], start: number, end: number): number => {
  let total = 0;
  for (let i = start; i < end; i++) total += entryTokenEstimate(entries[i]);
  return total;
};

const splitTurn = (
  entries: any[],
  turn: Turn,
  budget: number,
): { start: number; id: string } | undefined => {
  if (budget <= 0) return undefined;
  if (turn.end - turn.start <= 1) return undefined;
  for (let start = turn.start + 1; start < turn.end; start++) {
    if (!isValidCutEntry(entries[start])) continue;
    const size = rangeTokens(entries, start, turn.end);
    if (size > budget) continue;
    return { start, id: entries[start].id };
  }
  return undefined;
};

const collectHeadMessages = (entries: any[], boundaryStart: number, tailStart: number): any[] => {
  const messages: any[] = [];
  for (let i = boundaryStart; i < tailStart; i++) {
    const entry = entries[i];
    if (entry?.type === "compaction") continue;
    for (const m of entryMessages(entry)) messages.push(m);
  }
  return messages;
};

const lastUserEntryIndex = (entries: any[], from: number): number => {
  for (let i = entries.length - 1; i >= from; i--) {
    const msgs = entryMessages(entries[i]);
    if (msgs.some((m) => m?.role === "user")) return i;
  }
  return -1;
};

/**
 * OpenCode-style head|tail split on pi branch entries.
 * Tail is kept verbatim via firstKeptEntryId; head is summarized.
 */
export function selectTail(input: SelectTailInput): SelectionResult {
  const { branchEntries, config, contextWindow, reason } = input;
  if (!Array.isArray(branchEntries) || branchEntries.length === 0) {
    return { ok: false, reason: "no_entries" };
  }

  const { boundaryStart, previousSummary } = findBoundaryStart(branchEntries);
  const budget = preserveRecentBudget(config, contextWindow);
  const allTurns = buildTurns(branchEntries, boundaryStart);

  let keep: { start: number; id: string } | undefined;
  let splitTurnFlag = false;
  let keptTurns = 0;

  const limit = config.tailTurns;
  if (limit > 0 && allTurns.length > 0) {
    const recent = allTurns.slice(-limit);
    const sizes = recent.map((t) => rangeTokens(branchEntries, t.start, t.end));
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const turn = recent[i];
      const size = sizes[i];
      if (total + size <= budget) {
        total += size;
        keep = { start: turn.start, id: turn.id };
        keptTurns += 1;
        continue;
      }
      const remaining = budget - total;
      const split = splitTurn(branchEntries, turn, remaining);
      if (split) {
        keep = split;
        splitTurnFlag = true;
        keptTurns += 1;
      }
      break;
    }
  }

  // Fallback: keep the last user turn so pi always has a valid firstKeptEntryId.
  if (!keep || keep.start <= boundaryStart) {
    const lastUser = lastUserEntryIndex(branchEntries, boundaryStart);
    if (lastUser > boundaryStart) {
      keep = { start: lastUser, id: branchEntries[lastUser].id };
      keptTurns = Math.max(1, keptTurns);
      splitTurnFlag = false;
    } else if (lastUser === boundaryStart && previousSummary) {
      // Only previous summary to update; keep from last user (even if boundary).
      keep = { start: lastUser, id: branchEntries[lastUser].id };
      keptTurns = 1;
    } else if (branchEntries.length - 1 > boundaryStart) {
      const idx = branchEntries.length - 1;
      // Walk back to a valid cut
      for (let i = idx; i > boundaryStart; i--) {
        if (isValidCutEntry(branchEntries[i])) {
          keep = { start: i, id: branchEntries[i].id };
          keptTurns = 1;
          break;
        }
      }
    }
  }

  if (!keep?.id) return { ok: false, reason: "no_kept_id" };

  // Overflow: keep the overflowing user turn verbatim (OpenCode replay analogue).
  let overflowStrip = false;
  if (reason === "overflow") {
    const lastUser = lastUserEntryIndex(branchEntries, boundaryStart);
    if (lastUser >= 0 && lastUser >= keep.start) {
      // already in tail
      overflowStrip = true;
    } else if (lastUser > boundaryStart) {
      keep = { start: lastUser, id: branchEntries[lastUser].id };
      keptTurns = 1;
      splitTurnFlag = false;
      overflowStrip = true;
    }
  }

  const headMessages = collectHeadMessages(branchEntries, boundaryStart, keep.start);
  if (headMessages.length === 0 && !previousSummary && !input.previousSummary) {
    return { ok: false, reason: "nothing_to_summarize" };
  }

  return {
    ok: true,
    firstKeptEntryId: keep.id,
    tailStartIndex: keep.start,
    headMessages,
    splitTurn: splitTurnFlag,
    keptTurns,
    preservedRecentTokens: budget,
    overflowStrip,
  };
}
