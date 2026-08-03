import { writeFileSync } from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { pruneToolResults, stripOverflowMedia } from "./prune";
import { selectTail } from "./select";
import { summarizeHead, SummarizationError } from "./summarize";
import type { CompactionReason, OcCompactDetails, OcCompactStats } from "./types";

// Assumes vcc-hybrid overrideDefaultCompaction is false (or extension disabled).
// If both override session_before_compact, both run and last non-cancel wins.

const AUTO_CONTINUE_CUSTOM_TYPE = "oc-compact-auto-continue";
const AUTO_CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const AUTO_CONTINUE_OVERFLOW_PROMPT =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n" +
  AUTO_CONTINUE_PROMPT;

let lastStats: OcCompactStats | null = null;
let pendingOverflowStrip = false;
let pendingAutoContinueTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAutoContinueReason: CompactionReason | null = null;

const clearPendingAutoContinue = () => {
  if (pendingAutoContinueTimer) {
    clearTimeout(pendingAutoContinueTimer);
    pendingAutoContinueTimer = null;
  }
  pendingAutoContinueReason = null;
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

const scheduleAutoContinue = (pi: ExtensionAPI, reason: CompactionReason) => {
  clearPendingAutoContinue();
  pendingAutoContinueReason = reason;
  pendingAutoContinueTimer = setTimeout(async () => {
    pendingAutoContinueTimer = null;
    const r = pendingAutoContinueReason;
    pendingAutoContinueReason = null;
    const content = r === "overflow" ? AUTO_CONTINUE_OVERFLOW_PROMPT : AUTO_CONTINUE_PROMPT;
    try {
      await pi.sendMessage(
        {
          customType: AUTO_CONTINUE_CUSTOM_TYPE,
          content,
          display: false,
        },
        { triggerTurn: true },
      );
    } catch {
      // ignore
    }
  }, 0);
};

const resolveContextWindow = (ctx: any, fallbackReserve: number): number => {
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
  // Sensible default if unknown
  return Math.max(32_000, fallbackReserve * 4);
};

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

export const registerOcCompactHooks = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", () => {
    clearPendingAutoContinue();
  });

  pi.on("context", (event) => {
    const config = loadConfig();
    if (!config.enabled) return;

    let messages = event.messages as any[];
    let changed = false;

    if (config.prune) {
      const pruned = pruneToolResults(messages, config);
      if (pruned.prunedCount > 0) {
        messages = pruned.messages;
        changed = true;
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
        keptTurns: selection.keptTurns,
        splitTurn: selection.splitTurn,
        promptChars: summaryResult.promptChars,
        summaryLength: summaryResult.text.length,
        summaryPreview: summaryResult.text.slice(0, 500),
        previousSummaryUsed: Boolean(preparation.previousSummary),
        tokensBefore: preparation.tokensBefore,
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
    if (!event.fromExtension) return;
    const { reason, willRetry } = readCompactionEventContext(event);
    if (willRetry) return;

    const config = loadConfig();
    const stats = lastStats;
    if (stats) scheduleStatsNotify(ctx, stats);

    const shouldContinue =
      config.autoContinue &&
      (reason === "threshold" || reason === "overflow");
    if (shouldContinue) {
      scheduleAutoContinue(pi, reason ?? "threshold");
    }
  });
};
