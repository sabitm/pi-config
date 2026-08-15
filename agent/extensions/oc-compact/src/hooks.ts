import { writeFileSync } from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import {
  estimateContextTokensLocal,
  estimatePruneSavings,
  pruneToolResults,
  shouldPruneThisRequest,
  stripOverflowMedia,
} from "./prune";
import {
  consumeProactiveResume,
  estimateTokensAfterPrune,
  initialProactiveState,
  isWorkContinuing,
  reduceProactiveState,
  shouldScheduleAutoContinue,
  shouldTriggerProactiveCompact,
  type ProactiveState,
} from "./proactive";
import { selectTail } from "./select";
import { summarizeHead, SummarizationError } from "./summarize";
import type { CompactionReason, OcCompactDetails, OcCompactStats } from "./types";

// Assumes vcc-hybrid overrideDefaultCompaction is false (or extension disabled).
// If both override session_before_compact, both run and last non-cancel wins.

const AUTO_CONTINUE_CUSTOM_TYPE = "oc-compact-auto-continue";
const AUTO_CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

let lastStats: OcCompactStats | null = null;
let pendingOverflowStrip = false;
let pruneEngaged = false;
let pendingAutoContinueTimer: ReturnType<typeof setTimeout> | null = null;
let proactiveState: ProactiveState = initialProactiveState();

const clearPendingAutoContinue = () => {
  if (pendingAutoContinueTimer) {
    clearTimeout(pendingAutoContinueTimer);
    pendingAutoContinueTimer = null;
  }
};

const resetSessionState = () => {
  clearPendingAutoContinue();
  proactiveState = initialProactiveState();
  lastStats = null;
  pendingOverflowStrip = false;
  pruneEngaged = false;
};

const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const formatCompactionStats = (stats: OcCompactStats): string => {
  const split = stats.splitTurn ? ", split" : "";
  return `oc-compact: summarized ${stats.headMessages} messages, kept ~${formatTokens(stats.keptTokensEst)} tok tail (${stats.keptTurns} turns${split}), ${stats.reason}.`;
};

const readCompactionEventContext = (
  event: unknown,
): { reason?: CompactionReason; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason =
    raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow"
      ? raw.reason
      : undefined;
  return { reason, willRetry: raw.willRetry === true };
};

const isAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /abort/i.test(e.message ?? "");
};

const dbg = (enabled: boolean, data: Record<string, unknown>) => {
  if (!enabled) return;
  try {
    writeFileSync("/tmp/oc-compact-debug.json", JSON.stringify(data, null, 2));
  } catch {
    // ignore
  }
};

const notify = (ctx: any, message: string, level: "info" | "warning" | "error" = "info") => {
  try {
    ctx?.ui?.notify?.(message, level);
  } catch {
    // ignore
  }
};

const scheduleStatsNotify = (ctx: any, stats: OcCompactStats) => {
  setTimeout(() => notify(ctx, formatCompactionStats(stats), "info"), 500);
};

const scheduleAutoContinue = (pi: ExtensionAPI) => {
  clearPendingAutoContinue();
  pendingAutoContinueTimer = setTimeout(async () => {
    pendingAutoContinueTimer = null;
    try {
      await pi.sendMessage(
        {
          customType: AUTO_CONTINUE_CUSTOM_TYPE,
          content: AUTO_CONTINUE_PROMPT,
          display: false,
        },
        { triggerTurn: true },
      );
    } catch {
      // ignore
    }
  }, 0);
};

const resolveKnownContextWindow = (ctx: any): number | null => {
  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      return usage.contextWindow;
    }
  } catch {
    // ignore
  }
  const modelWindow = ctx?.model?.contextWindow;
  if (typeof modelWindow === "number" && modelWindow > 0) return modelWindow;
  return null;
};

const resolveContextWindow = (ctx: any, fallbackReserve: number): number =>
  resolveKnownContextWindow(ctx) ?? Math.max(32_000, fallbackReserve * 4);

const resolveAuth = async (ctx: any, model: any) => {
  if (!model) return null;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) return null;
    return auth;
  } catch {
    return null;
  }
};

/** Collect LLM-facing messages from the active branch (for prune savings estimate). */
const branchMessages = (ctx: any): any[] => {
  try {
    const entries = ctx?.sessionManager?.getBranch?.() ?? [];
    const messages: any[] = [];
    for (const entry of entries) {
      try {
        const ms = sessionEntryToContextMessages(entry) ?? [];
        for (const m of ms) messages.push(m);
      } catch {
        if (entry?.type === "message" && entry.message) messages.push(entry.message);
      }
    }
    return messages;
  } catch {
    return [];
  }
};

/**
 * Start extension-owned proactive compact.
 * ctx.compact aborts the current agent run (fire-and-forget), then reports reason=manual.
 * turn_end handlers are awaited before the next provider request, so this runs before the next LLM call.
 */
const requestProactiveCompact = (pi: ExtensionAPI, ctx: any) => {
  proactiveState = reduceProactiveState(proactiveState, { type: "request" });
  if (proactiveState.phase !== "pending") return;

  proactiveState = reduceProactiveState(proactiveState, { type: "started" });
  notify(ctx, "oc-compact: proactive mid-task compaction...", "info");

  try {
    ctx.compact({
      customInstructions:
        "Mid-task compaction: preserve active work state, open questions, and concrete next steps.",
      onComplete: () => {
        const { next, shouldResume } = consumeProactiveResume(proactiveState);
        proactiveState = next;
        if (shouldResume) scheduleAutoContinue(pi);
      },
      onError: () => {
        proactiveState = reduceProactiveState(proactiveState, { type: "failure" });
      },
    });
  } catch {
    proactiveState = reduceProactiveState(proactiveState, { type: "failure" });
  }
};

export const registerOcCompactHooks = (pi: ExtensionAPI) => {
  pi.on("session_start", () => {
    resetSessionState();
  });

  pi.on("session_shutdown", () => {
    resetSessionState();
  });

  pi.on("before_agent_start", () => {
    clearPendingAutoContinue();
  });

  pi.on("context", (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled) return;

    let messages = event.messages as any[];
    let changed = false;

    if (config.prune) {
      const contextWindow = resolveKnownContextWindow(ctx);
      const contextEstimate = estimateContextTokensLocal(messages);
      if (
        shouldPruneThisRequest({
          trigger: config.pruneTrigger,
          ratio: config.prunePressureRatio,
          contextWindow,
          reserveTokens: config.reserveTokens,
          contextEstimate,
          engaged: pruneEngaged,
        })
      ) {
        pruneEngaged = true;
        const pruned = pruneToolResults(messages, config);
        if (pruned.prunedCount > 0) {
          messages = pruned.messages;
          changed = true;
        }
      }
    }

    if (pendingOverflowStrip) {
      const stripped = stripOverflowMedia(messages);
      if (stripped.stripped > 0) {
        messages = stripped.messages;
        changed = true;
      }
      // One-shot: clear even if no images (avoid sticky flag).
      pendingOverflowStrip = false;
    }

    if (!changed) return;
    return { messages };
  });

  // Mid-task: after a tool batch, compact before the next provider request when near threshold.
  pi.on("turn_end", (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled || !config.autoContinue) return;

    const workContinuing = isWorkContinuing(event.message, event.toolResults);
    if (!workContinuing) return;

    const usage = (() => {
      try {
        return ctx.getContextUsage?.();
      } catch {
        return undefined;
      }
    })();
    const contextWindow =
      (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0
        ? usage.contextWindow
        : resolveContextWindow(ctx, config.reserveTokens)) ?? 0;

    const messages = branchMessages(ctx);
    const pruneSavings = estimatePruneSavings(messages, config);
    // When the prune latch is on, usage.tokens already reflects pruned requests while
    // savings come from persisted unpruned entries, so this can over-subtract slightly.
    const tokensAfterPrune = estimateTokensAfterPrune(usage?.tokens ?? null, pruneSavings);

    const trigger = shouldTriggerProactiveCompact({
      workContinuing,
      tokensAfterPrune,
      contextWindow,
      reserveTokens: config.reserveTokens,
      alreadyPending: proactiveState.phase !== "idle",
      enabled: config.enabled,
    });

    dbg(config.debug, {
      turn_end: true,
      workContinuing,
      usageTokens: usage?.tokens ?? null,
      pruneSavings,
      tokensAfterPrune,
      contextWindow,
      trigger,
      proactivePhase: proactiveState.phase,
    });

    if (!trigger) return;
    requestProactiveCompact(pi, ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Outer try/catch is mandatory: a thrown error lets pi fall through to stock compaction.
    try {
      const config = loadConfig();
      if (!config.enabled) return;

      const { preparation, branchEntries, customInstructions, signal } = event;
      const { reason, willRetry } = readCompactionEventContext(event);
      const compactionReason: CompactionReason = reason ?? "manual";

      const model = ctx.model;
      const contextWindow = resolveContextWindow(ctx, config.reserveTokens);

      const selection = selectTail({
        branchEntries: branchEntries as any[],
        config,
        contextWindow,
        reason: compactionReason,
        previousSummary: preparation.previousSummary,
      });

      if (!selection.ok) {
        const msg =
          selection.reason === "nothing_to_summarize"
            ? "oc-compact: nothing to summarize"
            : `oc-compact: cannot select tail (${selection.reason})`;
        notify(ctx, msg, "warning");
        dbg(config.debug, { cancelled: true, selection });
        return { cancel: true };
      }

      if (selection.overflowStrip) pendingOverflowStrip = true;

      const auth = await resolveAuth(ctx, model);
      if (!auth) {
        notify(
          ctx,
          "oc-compact: compaction failed: no API key for session model. No summary was written; run /compact again to retry.",
          "error",
        );
        dbg(config.debug, { cancelled: true, error: "no_auth" });
        return { cancel: true };
      }

      const summaryResult = await summarizeHead({
        headMessages: selection.headMessages,
        tailMessages: selection.tailMessages,
        previousSummary: preparation.previousSummary,
        customInstructions,
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        config,
      });

      const keptTokensEst = (branchEntries as any[])
        .slice(selection.tailStartIndex)
        .reduce((sum: number, entry: any) => {
          if (entry?.type === "message" && entry.message) {
            return sum + estimateTokens(entry.message);
          }
          return sum;
        }, 0);

      lastStats = {
        headMessages: selection.headMessages.length,
        keptTurns: selection.keptTurns,
        keptTokensEst,
        splitTurn: selection.splitTurn,
        reason: compactionReason,
      };

      const details: OcCompactDetails = {
        compactor: "oc-compact",
        version: 1,
        splitTurn: selection.splitTurn,
        keptTurns: selection.keptTurns,
        preservedRecentTokens: selection.preservedRecentTokens,
        headMessageCount: selection.headMessages.length,
        previousSummaryUsed: Boolean(preparation.previousSummary),
        reason: compactionReason,
        willRetry,
        mediaStripped: summaryResult.mediaStripped,
      };

      dbg(config.debug, {
        mode: summaryResult.mode,
        reason: compactionReason,
        willRetry,
        firstKeptEntryId: selection.firstKeptEntryId,
        headMessages: selection.headMessages.length,
        tailMessages: selection.tailMessages.length,
        keptTurns: selection.keptTurns,
        splitTurn: selection.splitTurn,
        promptChars: summaryResult.promptChars,
        retainedSuffixChars: summaryResult.retainedSuffixChars,
        summaryLength: summaryResult.text.length,
        summaryPreview: summaryResult.text.slice(0, 500),
        previousSummaryUsed: Boolean(preparation.previousSummary),
        tokensBefore: preparation.tokensBefore,
        proactivePhase: proactiveState.phase,
      });

      return {
        compaction: {
          summary: summaryResult.text,
          firstKeptEntryId: selection.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: summaryResult.usage,
          details,
        },
      };
    } catch (err) {
      if (isAbortError(err) || (event as any)?.signal?.aborted) {
        return { cancel: true };
      }
      const message =
        err instanceof SummarizationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      notify(
        ctx,
        `oc-compact: compaction failed: ${message}. No summary was written; run /compact again to retry.`,
        "error",
      );
      try {
        const config = loadConfig();
        dbg(config.debug, { cancelled: true, error: message });
      } catch {
        // ignore
      }
      return { cancel: true };
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    pruneEngaged = false;
    if (!event.fromExtension) {
      // Host stock path: clear any stale proactive tracking.
      proactiveState = reduceProactiveState(proactiveState, { type: "clear" });
      return;
    }

    const { reason, willRetry } = readCompactionEventContext(event);
    const config = loadConfig();
    const stats = lastStats;
    if (stats) scheduleStatsNotify(ctx, stats);

    const tracked = proactiveState.phase !== "idle" && proactiveState.resumeOnSuccess;
    const belongsToProactiveCompact = shouldScheduleAutoContinue({
      autoContinue: config.autoContinue,
      reason,
      willRetry,
      isTrackedProactive: tracked,
    });

    if (belongsToProactiveCompact) {
      // ctx.compact invokes onComplete only after the host clears manual-compaction state.
      return;
    }

    // Settled without proactive resume (final threshold/overflow/manual user compact, or willRetry).
    proactiveState = reduceProactiveState(proactiveState, { type: "clear" });
  });
};

/** Test seam: reset module-level session tracking. */
export const __resetProactiveStateForTests = resetSessionState;

/** Test seam: arm the one-shot overflow media strip. */
export const __setPendingOverflowStripForTests = (value: boolean) => {
  pendingOverflowStrip = value;
};
