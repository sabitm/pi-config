import { complete } from "@earendil-works/pi-ai/compat";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compileRanked } from "./vcc/src/core/summarize";
import { RECALL_NOTE } from "./vcc/src/core/format";
import {
  buildOwnCut,
  resolveSmartKeepUserTurns,
  type CompactionStats,
  type OwnCutResult,
} from "./vcc/src/hooks/before-compact";
import {
  calibrateCharsPerToken,
  estimateMessageContentChars,
  estimateTokensFromChars,
} from "./vcc/src/core/token-estimate";
import {
  loadSettings,
  type PiVccSettings,
} from "./vcc/src/core/settings";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  parseKeepAndPrompt,
} from "./vcc/src/core/compact-args";
import type { PiVccCompactionDetails } from "./vcc/src/details";
import type { CompactionReason } from "./vcc/src/types";

export { PI_VCC_COMPACT_INSTRUCTION } from "./vcc/src/core/compact-args";

// System prompt for the hybrid synthesis pass. The LLM reasons over pi-vcc's
// algorithmic distillate (sections + ranked transcript), not the raw session,
// so the prompt is short and the input is tiny relative to stock pi compaction.
const HYBRID_SYSTEM_PROMPT = `You are a context summarization assistant. Below is an algorithmic distillation of a coding session: structured sections plus a ranked chronological transcript. Synthesize it into a coherent structured summary.

Preserve EVERY file path, function name, identifier, and error message verbatim from the distillate. Do not invent facts not present. Do not continue the conversation or respond to questions in it. ONLY output the structured summary.

TECHNICAL CONTRACTS ARE HIGH-RISK: copy them character-for-character, never paraphrase. This includes fenced code blocks, function signatures, byte/hex sequences (e.g. 0x78, adler32), numeric constants, exact API names, and error strings. A directionally-correct but imprecise restatement (e.g. summarizing a byte-level protocol detail as "prepends a header") produces silently-wrong downstream code. When a distillate line describes a precise contract, reproduce its exact wording or quote the code verbatim rather than rephrasing it.

Use this format:

## Goal
What the user is trying to accomplish.

## Constraints & Preferences
Requirements and stated preferences.

## Progress
### Done
- Completed tasks

### In Progress
- Current work

### Blocked
- Issues, if any

## Key Decisions
- **Decision**: Rationale

## Next Steps
1. What should happen next

## Critical Context
- Data needed to continue

Keep each section concise. If a section has no content in the distillate, omit it.`;

const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const formatCompactionStats = (stats: CompactionStats, mode: "hybrid" | "vcc"): string => {
  const notes: string[] = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) notes.push("smart-keep");
  notes.push(mode);
  return `vcc-hybrid: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
};

let lastStats: CompactionStats | null = null;
let lastMode: "hybrid" | "vcc" = "hybrid";
let pendingFollowUpPrompt: string | null = null;
let lastCompactWasExplicit = false;
const AUTO_CONTINUE_CUSTOM_TYPE = "vcc-hybrid-auto-continue";
const AUTO_CONTINUE_PROMPT =
  "Continue from where you left off after automatic context compaction. Do not restate the compaction summary; proceed with the task.";
let pendingAutoContinueTimer: ReturnType<typeof setTimeout> | null = null;

const clearPendingAutoContinue = () => {
  if (pendingAutoContinueTimer) {
    clearTimeout(pendingAutoContinueTimer);
    pendingAutoContinueTimer = null;
  }
};

const scheduleAutoContinue = (pi: ExtensionAPI) => {
  clearPendingAutoContinue();
  pendingAutoContinueTimer = setTimeout(async () => {
    pendingAutoContinueTimer = null;
    try {
      await pi.sendMessage(
        { customType: AUTO_CONTINUE_CUSTOM_TYPE, content: AUTO_CONTINUE_PROMPT, display: false },
        { triggerTurn: true },
      );
    } catch {}
  }, 0);
};

export const getLastCompactionStats = () => lastStats;

const readCompactionEventContext = (event: unknown): { reason?: CompactionReason; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason =
    raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow"
      ? raw.reason
      : undefined;
  return { reason, willRetry: raw.willRetry === true };
};

export const scheduleCompactionStatsNotify = (ctx: any, stats: CompactionStats, mode: "hybrid" | "vcc") => {
  setTimeout(() => {
    try {
      ctx?.ui?.notify?.(formatCompactionStats(stats, mode), "info");
    } catch {}
  }, 500);
};

const parseCompactionInstructions = (customInstructions?: string) => {
  const trimmed = customInstructions?.trim();
  if (trimmed === PI_VCC_COMPACT_INSTRUCTION) {
    return { isPiVcc: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  }
  const keepPrefix = `${PI_VCC_COMPACT_INSTRUCTION} `;
  if (trimmed?.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      isPiVcc: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: null,
    };
  }
  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    isPiVcc: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try {
    writeFileSync("/tmp/vcc-hybrid-debug.json", JSON.stringify(data, null, 2));
  } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

/**
 * Resolve the model for the hybrid synthesis pass. Returns null when no model
 * is available (caller falls back to the pure distillate).
 */
const resolveSummaryModel = (ctx: any, settings: PiVccSettings): any | null => {
  const override = settings.summaryModel;
  if (override) {
    const m = ctx.modelRegistry.find?.(override.provider, override.id);
    if (m) return m;
  }
  // Default: the active session model.
  return ctx.model ?? null;
};

/**
 * Run the LLM synthesis pass over the distillate. Returns the synthesized
 * summary text, or null on any failure (caller falls back to distillate).
 */
const runSynthesis = async (
  ctx: any,
  settings: PiVccSettings,
  distillate: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; usage?: any } | null> => {
  if (!settings.hybridSynthesis) return null;
  const model = resolveSummaryModel(ctx, settings);
  if (!model) return null;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) return null;

  try {
    const response = await complete(
      model,
      {
        systemPrompt: HYBRID_SYSTEM_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: distillate }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: 2048,
        signal,
        cacheRetention: "none" as const,
        sessionId: uuidv7(),
      },
    );
    const text = response.content
      .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) return null;
    return { text, usage: response.usage };
  } catch {
    // Stream drop, abort, auth failure, or any provider error: fall back.
    return null;
  }
};

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", () => {
    clearPendingAutoContinue();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const { reason, willRetry } = readCompactionEventContext(event);
    const settings = loadSettings();

    const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } =
      parseCompactionInstructions(customInstructions);
    pendingFollowUpPrompt = null;
    // Always handle explicit /pi-vcc marker. Otherwise only when opted in.
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;

    // ── Calibration: estimate chars/token from the real pre-compaction size ──
    const calibrationCut = buildOwnCut(branchEntries as any[], 0);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message: any) => sum + estimateMessageContentChars(message.content),
          0,
        )
      : 0;
    const calibrationSummaryChars =
      typeof preparation.previousSummary === "string" ? preparation.previousSummary.length : 0;
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
    );

    // ── Smart keep-tail ──
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
    });
    const ownCut: OwnCutResult = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns);

    if (!ownCut.ok) {
      const fallbackToCore = !isPiVcc && (reason === "overflow" || willRetry);
      dbg(settings, { cancelled: !fallbackToCore, fallbackToCore, reason: ownCut.reason });
      if (fallbackToCore) return; // let pi-core handle overflow recovery
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    pendingFollowUpPrompt = followUpPrompt;
    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    // ── Estimate kept tokens for the notify toast ──
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce(
      (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
      0,
    );
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst: estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      smartFromKeep: smartKeep.fromKeep,
      reason,
      willRetry,
    };

    // ── Stage 1: pi-vcc algorithmic distillation (no LLM) ──
    const RANKED_BRIEF_BUDGET_TOKENS = 1100;
    const RANKED_BRIEF_CEILING_TOKENS = 2000;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    const distillate = compileRanked({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

    // ── Stage 2: hybrid LLM synthesis over the distillate ──
    const synthesis = await runSynthesis(ctx, settings, distillate, event.signal);
    let summary: string;
    let usage: any = undefined;
    if (synthesis?.text) {
      summary = synthesis.text;
      usage = synthesis.usage;
      lastMode = "hybrid";
    } else {
      // Fallback: the pure algorithmic distillate. Compaction never fails.
      summary = distillate;
      lastMode = "vcc";
    }
    // Append the recall note so the agent knows history is searchable.
    if (summary && !summary.includes(RECALL_NOTE)) {
      summary = `${summary}\n\n---\n\n${RECALL_NOTE}`;
    }

    lastCompactWasExplicit = isPiVcc;

    dbg(settings, {
      mode: lastMode,
      compaction: { reason, willRetry },
      messagesToSummarize: agentMessages.length,
      firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      tokenEstimate,
      distillateLength: distillate.length,
      distillatePreview: distillate.slice(0, 500),
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
    });

    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections: [...summary.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      reason,
      willRetry,
    };

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
        usage,
      },
    };
  });

  pi.on("session_compact", async (event, ctx) => {
    const { reason, willRetry } = readCompactionEventContext(event);
    if (!event.fromExtension) return;
    const followUpPrompt = pendingFollowUpPrompt;
    pendingFollowUpPrompt = null;
    if (willRetry) return;
    const stats = lastStats;
    if (!stats) return;
    const shouldContinueAfterAutoCompact =
      (reason === "threshold" || reason === "overflow") &&
      loadSettings().continueAfterThresholdCompact;
    scheduleCompactionStatsNotify(ctx, stats, lastMode);
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    } else if (shouldContinueAfterAutoCompact) {
      scheduleAutoContinue(pi);
    }
  });
};

const REASON_MESSAGES: Record<string, string> = {
  no_live_messages: "vcc-hybrid: Nothing to compact (no live messages)",
  too_few_live_messages: "vcc-hybrid: Too few messages to compact",
};
