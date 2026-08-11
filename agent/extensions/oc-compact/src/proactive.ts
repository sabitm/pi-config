import type { CompactionReason } from "./types";

/** Extension-owned proactive mid-task compaction lifecycle. */
export type ProactivePhase = "idle" | "pending" | "compacting";

export interface ProactiveState {
  phase: ProactivePhase;
  /** True once a tracked proactive compact was requested and not yet settled. */
  resumeOnSuccess: boolean;
}

export const initialProactiveState = (): ProactiveState => ({
  phase: "idle",
  resumeOnSuccess: false,
});

export interface ProactiveTriggerInput {
  /** Tool results or assistant tool-use batch means work is clearly continuing. */
  workContinuing: boolean;
  /** Estimated tokens after applying ephemeral prune savings. */
  tokensAfterPrune: number | null;
  contextWindow: number;
  /** Host safe threshold uses contextWindow - reserveTokens. */
  reserveTokens: number;
  /** Already waiting on a proactive compact. */
  alreadyPending: boolean;
  enabled: boolean;
}

/**
 * Decide whether turn_end should start extension-owned proactive compaction.
 * Threshold matches host shouldCompact: tokens > contextWindow - reserveTokens.
 */
export function shouldTriggerProactiveCompact(input: ProactiveTriggerInput): boolean {
  if (!input.enabled) return false;
  if (input.alreadyPending) return false;
  if (!input.workContinuing) return false;
  if (input.tokensAfterPrune == null) return false;
  if (input.contextWindow <= 0) return false;
  const threshold = input.contextWindow - Math.max(0, input.reserveTokens);
  return input.tokensAfterPrune > threshold;
}

/** Assistant message contains tool calls (or toolResults batch is non-empty). */
export function isWorkContinuing(message: unknown, toolResults: unknown): boolean {
  if (Array.isArray(toolResults) && toolResults.length > 0) return true;
  const msg = message as { role?: string; content?: unknown } | null;
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall");
}

/**
 * Post-pruning context estimate: host usage may still reflect unpruned tool bodies.
 * tokens - pruneSavings, floored at 0. null stays null (unknown).
 */
export function estimateTokensAfterPrune(
  usageTokens: number | null | undefined,
  pruneSavingsEst: number,
): number | null {
  if (usageTokens == null || !Number.isFinite(usageTokens)) return null;
  return Math.max(0, usageTokens - Math.max(0, pruneSavingsEst));
}

export interface AutoContinueDecisionInput {
  autoContinue: boolean;
  reason: CompactionReason | undefined;
  willRetry: boolean;
  /** Only extension-tracked proactive mid-task compact may resume. */
  isTrackedProactive: boolean;
}

/**
 * Whether session_compact should schedule a hidden continuation turn.
 * Host already retries overflow when willRetry=true; final threshold/overflow
 * completions must not spuriously restart the model.
 */
export function shouldScheduleAutoContinue(input: AutoContinueDecisionInput): boolean {
  if (!input.autoContinue) return false;
  if (input.willRetry) return false;
  if (!input.isTrackedProactive) return false;
  // Programmatic ctx.compact is reported as reason=manual.
  return input.reason === "manual" || input.reason === undefined;
}

export type ProactiveEvent =
  | { type: "request" }
  | { type: "started" }
  | { type: "success" }
  | { type: "failure" }
  | { type: "clear" };

/**
 * Pure proactive state transitions for overlap/failure robustness.
 * request while pending/compacting is ignored (no overlap).
 */
export function reduceProactiveState(state: ProactiveState, event: ProactiveEvent): ProactiveState {
  switch (event.type) {
    case "request":
      if (state.phase !== "idle") return state;
      return { phase: "pending", resumeOnSuccess: true };
    case "started":
      if (state.phase === "idle") return state;
      return { ...state, phase: "compacting" };
    case "success":
      return initialProactiveState();
    case "failure":
      return initialProactiveState();
    case "clear":
      return initialProactiveState();
    default:
      return state;
  }
}

/** Take resume flag if success settles a tracked proactive compact. */
export function consumeProactiveResume(
  state: ProactiveState,
): { next: ProactiveState; shouldResume: boolean } {
  if (state.phase === "idle" || !state.resumeOnSuccess) {
    return { next: initialProactiveState(), shouldResume: false };
  }
  return { next: initialProactiveState(), shouldResume: true };
}
