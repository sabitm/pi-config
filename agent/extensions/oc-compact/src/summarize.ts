import { complete } from "@earendil-works/pi-ai/compat";
import { retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { OcCompactConfig } from "./types";
import { prepareHeadMessages, serializeHead } from "./serialize";

export class SummarizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizationError";
  }
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`;

export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

export const buildSummaryPrompt = (input: {
  previousSummary?: string;
  customInstructions?: string;
}): string => {
  const parts: string[] = [];
  if (input.previousSummary) {
    parts.push(
      `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`,
    );
  } else {
    parts.push("Create a new anchored summary from the conversation history.");
  }
  parts.push(SUMMARY_TEMPLATE);
  if (input.customInstructions?.trim()) {
    parts.push(`Additional focus: ${input.customInstructions.trim()}`);
  }
  return parts.join("\n\n");
};

const extractText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
};

const isAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /abort/i.test(e.message ?? "");
};

export interface SummarizeInput {
  headMessages: any[];
  previousSummary?: string;
  customInstructions?: string;
  model: any;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  config: OcCompactConfig;
  /** Prefer multi-turn head + prompt; set false to force serialized single-user blob. */
  multiTurn?: boolean;
}

export interface SummarizeResult {
  text: string;
  usage?: any;
  mediaStripped: number;
  promptChars: number;
  mode: "multi-turn" | "serialized";
}

/**
 * LLM anchored summary over HEAD only.
 * Throws SummarizationError on failure (caller cancels; never falls through to stock).
 */
export async function summarizeHead(input: SummarizeInput): Promise<SummarizeResult> {
  const { config } = input;
  if (!input.model) throw new SummarizationError("No session model available");
  if (!input.apiKey) throw new SummarizationError("No API key available for session model");

  const prepared = prepareHeadMessages(input.headMessages, config);
  const promptText = buildSummaryPrompt({
    previousSummary: input.previousSummary,
    customInstructions: input.customInstructions,
  });

  const multiTurn = input.multiTurn !== false;
  let messages: any[];
  let mode: "multi-turn" | "serialized";
  let promptChars = promptText.length;

  if (multiTurn && prepared.messages.length > 0) {
    const llmHead = convertToLlm(prepared.messages);
    messages = [
      ...llmHead,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: promptText }],
        timestamp: Date.now(),
      },
    ];
    mode = "multi-turn";
    promptChars += JSON.stringify(llmHead).length;
  } else {
    const body = serializeHead(prepared.messages);
    const full = `<conversation>\n${body}\n</conversation>\n\n${promptText}`;
    messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: full }],
        timestamp: Date.now(),
      },
    ];
    mode = "serialized";
    promptChars = full.length;
  }

  const maxTokens = Math.min(
    config.summaryMaxTokens,
    input.model.maxTokens > 0 ? input.model.maxTokens : Number.POSITIVE_INFINITY,
  );

  const retryPolicy = {
    enabled: config.retry.enabled,
    maxRetries: config.retry.maxRetries,
    baseDelayMs: config.retry.baseDelayMs,
  };

  try {
    const response = await retryAssistantCall(
      () =>
        complete(
          input.model,
          {
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            messages,
          },
          {
            apiKey: input.apiKey,
            headers: input.headers,
            env: input.env,
            maxTokens,
            signal: input.signal,
            cacheRetention: "none" as const,
            sessionId: uuidv7(),
          },
        ),
      retryPolicy,
      input.signal,
    );

    if (response.stopReason === "error") {
      throw new SummarizationError(response.errorMessage || "Summarization failed");
    }
    if (response.stopReason === "aborted") {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    const text = extractText(response.content);
    if (!text) throw new SummarizationError("Summarization returned empty text");

    return {
      text,
      usage: response.usage,
      mediaStripped: prepared.mediaStripped,
      promptChars,
      mode,
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err instanceof SummarizationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SummarizationError(message || "Summarization failed");
  }
}
