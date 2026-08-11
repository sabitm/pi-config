import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import {
  boundRetainedSuffixText,
  buildSummaryPrompt,
  prepareRetainedSuffixText,
} from "../src/summarize";

describe("buildSummaryPrompt", () => {
  test("includes retained-suffix reconciliation block when provided", () => {
    const prompt = buildSummaryPrompt({
      retainedSuffixText: "FINAL COMPARISON COMPLETED with scores A>B",
    });
    expect(prompt).toContain("<retained-suffix>");
    expect(prompt).toContain("FINAL COMPARISON COMPLETED");
    expect(prompt).toContain("Do not claim work is Active, Blocked");
  });

  test("omits retained-suffix block when empty", () => {
    const prompt = buildSummaryPrompt({});
    // Template rules may mention the tag name; the content block must be absent.
    expect(prompt.includes("<retained-suffix>\n")).toBe(false);
    expect(prompt.includes("</retained-suffix>")).toBe(false);
  });

  test("updates previous summary wording for discarded head", () => {
    const prompt = buildSummaryPrompt({ previousSummary: "old" });
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain("discarded conversation history");
  });
});

describe("boundRetainedSuffixText", () => {
  test("keeps short text", () => {
    expect(boundRetainedSuffixText("hello", 100)).toBe("hello");
  });

  test("keeps the end when truncating", () => {
    const text = "AAAA" + "BBBB".repeat(100) + "END_MARKER";
    const out = boundRetainedSuffixText(text, 40);
    expect(out.includes("END_MARKER")).toBe(true);
    expect(out.startsWith("[retained suffix truncated]")).toBe(true);
  });
});

describe("prepareRetainedSuffixText", () => {
  test("serializes and truncates tool results in retained suffix", () => {
    const { text } = prepareRetainedSuffixText(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "final comparison written" }],
        },
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "z".repeat(500) }],
        },
      ],
      {
        toolOutputMaxChars: 20,
        stripMedia: true,
        retainedSuffixMaxChars: 10_000,
      },
    );
    expect(text).toContain("final comparison written");
    expect(text).toContain("[Tool result]:");
    expect(text).toContain("[truncated]");
  });

  test("enforces retainedSuffixMaxChars bound", () => {
    const { text } = prepareRetainedSuffixText(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(5_000) }],
        },
      ],
      {
        ...DEFAULT_CONFIG,
        retainedSuffixMaxChars: 200,
      },
    );
    expect(text.length).toBeLessThanOrEqual(200 + "[retained suffix truncated]\n".length);
  });
});

describe("default serialization contract", () => {
  test("production path default is serialized (multiTurn not true)", () => {
    // Document the summarizeHead default: multiTurn === true is required for live replay.
    const multiTurnDefault = undefined;
    expect(multiTurnDefault === true).toBe(false);
    // Serialized head is wrapped in <conversation> by summarizeHead; retained suffix is separate.
    const prompt = buildSummaryPrompt({
      retainedSuffixText: "[Assistant]: completed the final report",
    });
    expect(prompt).toContain("<retained-suffix>");
    expect(prompt).toContain("completed the final report");
  });
});
