export type CompactionReason = "manual" | "threshold" | "overflow";

export interface OcCompactRetry {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export interface OcCompactConfig {
  /** When false, passthrough to stock pi compaction. Failure paths never use this. */
  enabled: boolean;
  prune: boolean;
  pruneProtectTokens: number;
  pruneMinimumTokens: number;
  pruneTailTurns: number;
  pruneProtectedTools: string[];
  tailTurns: number;
  /** null = clamp(floor(0.25 * usable), 2000, 8000) */
  preserveRecentTokens: number | null;
  reserveTokens: number;
  toolOutputMaxChars: number;
  stripMedia: boolean;
  /**
   * When true, resume only after extension-initiated proactive mid-task compaction.
   * Final host threshold/overflow completions never auto-continue.
   */
  autoContinue: boolean;
  summaryMaxTokens: number;
  /** Soft cap on retained-suffix serialization chars fed to the summary model. */
  retainedSuffixMaxChars: number;
  retry: OcCompactRetry;
  debug: boolean;
}

export interface OcCompactDetails {
  compactor: "oc-compact";
  version: 1;
  splitTurn: boolean;
  keptTurns: number;
  preservedRecentTokens: number;
  headMessageCount: number;
  previousSummaryUsed: boolean;
  reason: CompactionReason;
  willRetry: boolean;
  mediaStripped: number;
}

export interface OcCompactStats {
  headMessages: number;
  keptTurns: number;
  keptTokensEst: number;
  splitTurn: boolean;
  reason: CompactionReason;
}

export interface SelectionOk {
  ok: true;
  firstKeptEntryId: string;
  tailStartIndex: number;
  headMessages: any[];
  /** Messages kept verbatim after the cut (for summary reconciliation). */
  tailMessages: any[];
  splitTurn: boolean;
  keptTurns: number;
  preservedRecentTokens: number;
  /** Overflow path: strip images from the kept overflowing user turn on next context emit. */
  overflowStrip: boolean;
}

export interface SelectionErr {
  ok: false;
  reason: "no_entries" | "no_kept_id" | "nothing_to_summarize";
}

export type SelectionResult = SelectionOk | SelectionErr;
