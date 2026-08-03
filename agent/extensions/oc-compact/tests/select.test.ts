import { describe, expect, test } from "bun:test";
import { preserveRecentBudget, selectTail } from "../src/select";
import { DEFAULT_CONFIG } from "../src/config";

const msg = (id: string, role: string, text: string) => ({
  id,
  type: "message",
  message: {
    role,
    content: role === "assistant" ? [{ type: "text", text }] : text,
  },
});

const toolResult = (id: string, text: string) => ({
  id,
  type: "message",
  message: {
    role: "toolResult",
    toolName: "bash",
    content: [{ type: "text", text }],
  },
});

describe("preserveRecentBudget", () => {
  test("uses explicit override", () => {
    expect(
      preserveRecentBudget({ ...DEFAULT_CONFIG, preserveRecentTokens: 1234 }, 200_000),
    ).toBe(1234);
  });

  test("clamps 25% of usable between 2k and 8k", () => {
    // usable = 200k - 16k = 184k; 25% = 46k -> clamp 8k
    expect(preserveRecentBudget(DEFAULT_CONFIG, 200_000)).toBe(8_000);
    // usable = 20k - 16k = 4k; 25% = 1k -> clamp 2k
    expect(preserveRecentBudget(DEFAULT_CONFIG, 20_000)).toBe(2_000);
  });
});

describe("selectTail", () => {
  test("keeps last N user turns within budget", () => {
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply1"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply3"),
    ];
    const result = selectTail({
      branchEntries: entries,
      config: { ...DEFAULT_CONFIG, tailTurns: 2, preserveRecentTokens: 50_000 },
      contextWindow: 200_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.firstKeptEntryId).toBe("u2");
    expect(result.keptTurns).toBe(2);
    expect(result.headMessages.some((m: any) => m.role === "user" && m.content === "one")).toBe(true);
    expect(result.headMessages.some((m: any) => m.content === "two")).toBe(false);
  });

  test("does not cut at toolResult", () => {
    const entries = [
      msg("u1", "user", "start"),
      msg("a1", "assistant", "working"),
      toolResult("t1", "x".repeat(40_000)),
      msg("a2", "assistant", "more"),
      msg("u2", "user", "next"),
    ];
    const result = selectTail({
      branchEntries: entries,
      config: { ...DEFAULT_CONFIG, tailTurns: 1, preserveRecentTokens: 100 },
      contextWindow: 200_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // firstKept must be a valid cut id, never the toolResult alone without a valid cut
    expect(result.firstKeptEntryId).not.toBe("");
    const keptEntry = entries.find((e) => e.id === result.firstKeptEntryId);
    expect(keptEntry?.message?.role).not.toBe("toolResult");
  });

  test("respects previous compaction boundary", () => {
    const entries = [
      msg("old_u", "user", "ancient"),
      msg("old_a", "assistant", "ancient reply"),
      {
        id: "c1",
        type: "compaction",
        summary: "prior summary",
        firstKeptEntryId: "u1",
      },
      msg("u1", "user", "after compact"),
      msg("a1", "assistant", "ok"),
      msg("u2", "user", "latest"),
    ];
    const result = selectTail({
      branchEntries: entries,
      config: { ...DEFAULT_CONFIG, tailTurns: 1, preserveRecentTokens: 50_000 },
      contextWindow: 200_000,
      previousSummary: "prior summary",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.firstKeptEntryId).toBe("u2");
    // Head should not include pre-boundary ancient messages
    const texts = JSON.stringify(result.headMessages);
    expect(texts.includes("ancient")).toBe(false);
    expect(texts.includes("after compact")).toBe(true);
  });

  test("overflow forces last user into tail", () => {
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "r1"),
      msg("u2", "user", "two with image"),
    ];
    const result = selectTail({
      branchEntries: entries,
      config: { ...DEFAULT_CONFIG, tailTurns: 1, preserveRecentTokens: 50_000 },
      contextWindow: 200_000,
      reason: "overflow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.firstKeptEntryId).toBe("u2");
    expect(result.overflowStrip).toBe(true);
  });
});
