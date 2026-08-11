import { describe, expect, test } from "bun:test";
import {
  collectPruneCandidates,
  pruneToolResults,
  selectPruneIndices,
  stripOverflowMedia,
} from "../src/prune";
import { PRUNE_MARKER } from "../src/serialize";
import { DEFAULT_CONFIG } from "../src/config";

const bigTool = (name: string, chars: number) => ({
  role: "toolResult" as const,
  toolName: name,
  content: [{ type: "text", text: "x".repeat(chars) }],
  isError: false,
});

describe("pruneToolResults", () => {
  test("no-ops when prune disabled", () => {
    const messages = [
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      bigTool("bash", 100_000),
      { role: "user", content: "u2" },
      bigTool("bash", 100_000),
    ];
    const out = pruneToolResults(messages, { ...DEFAULT_CONFIG, prune: false });
    expect(out.prunedCount).toBe(0);
    expect(out.messages).toBe(messages);
  });

  test("protects recent turns preferentially and protected tools", () => {
    // Structure: older tool outs, then 2 recent user turns.
    // chars/4 heuristic: 200_000 chars ≈ 50k tokens each.
    const messages = [
      { role: "user", content: "old" },
      bigTool("bash", 200_000),
      bigTool("skill", 200_000),
      { role: "user", content: "mid" },
      bigTool("bash", 200_000),
      { role: "user", content: "new1" },
      bigTool("bash", 50_000),
      { role: "user", content: "new2" },
      bigTool("bash", 50_000),
    ];
    const out = pruneToolResults(messages, {
      ...DEFAULT_CONFIG,
      pruneProtectTokens: 40_000,
      pruneMinimumTokens: 20_000,
      pruneTailTurns: 2,
      pruneProtectedTools: ["skill"],
    });
    const skill = out.messages.find((m: any) => m.toolName === "skill");
    expect(skill.content[0].text.includes(PRUNE_MARKER)).toBe(false);
    // Newest tools (new1/new2, ~12.5k each) stay under 40k protect; older may prune.
    if (out.prunedCount > 0) {
      const pruned = out.messages.filter(
        (m: any) =>
          m.role === "toolResult" &&
          typeof m.content?.[0]?.text === "string" &&
          m.content[0].text.includes(PRUNE_MARKER),
      );
      expect(pruned.length).toBe(out.prunedCount);
      expect(pruned.every((m: any) => m.toolName !== "skill")).toBe(true);
      // Recent-turn tools should remain unpruned when protect budget covers them.
      const lastBash = out.messages[out.messages.length - 1];
      expect(lastBash.content[0].text.includes(PRUNE_MARKER)).toBe(false);
    }
  });

  test("prunes older outputs inside a single huge user turn", () => {
    // One user prompt, many large tool results — previously never pruned
    // because pruneTailTurns skipped the whole turn without a token bound.
    // ~25k tokens each; protect 40k keeps the two newest atomic results, then prunes older.
    const messages: any[] = [{ role: "user", content: "research" }];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { i } }],
      });
      messages.push(bigTool("bash", 100_000));
    }
    const out = pruneToolResults(messages, {
      ...DEFAULT_CONFIG,
      pruneProtectTokens: 40_000,
      pruneMinimumTokens: 20_000,
      pruneTailTurns: 2,
    });
    expect(out.prunedCount).toBeGreaterThan(0);
    expect(out.prunedTokensEst).toBeGreaterThan(20_000);
    const toolResults = out.messages.filter((m: any) => m.role === "toolResult");
    // Newest eligible results cross the finite protection boundary atomically and remain.
    const newest = toolResults[toolResults.length - 1];
    const secondNewest = toolResults[toolResults.length - 2];
    expect(newest.content[0].text.includes(PRUNE_MARKER)).toBe(false);
    expect(secondNewest.content[0].text.includes(PRUNE_MARKER)).toBe(false);
    // Oldest eligible results are pruned despite being in the same user turn.
    const oldest = toolResults[0];
    expect(oldest.content[0].text.includes(PRUNE_MARKER)).toBe(true);
  });

  test("skips error tool results", () => {
    const messages = [
      { role: "user", content: "a" },
      {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "e".repeat(200_000) }],
      },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      bigTool("bash", 200_000),
    ];
    const out = pruneToolResults(messages, {
      ...DEFAULT_CONFIG,
      pruneProtectTokens: 100,
      pruneMinimumTokens: 10,
      pruneTailTurns: 2,
    });
    const err = out.messages.find((m: any) => m.isError);
    expect(err.content[0].text.includes(PRUNE_MARKER)).toBe(false);
  });

  test("idempotent on already-pruned markers", () => {
    const messages = [
      { role: "user", content: "a" },
      {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: PRUNE_MARKER }],
      },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      bigTool("bash", 200_000),
    ];
    const first = pruneToolResults(messages, {
      ...DEFAULT_CONFIG,
      pruneProtectTokens: 0,
      pruneMinimumTokens: 0,
      pruneTailTurns: 0,
    });
    expect(first.prunedCount).toBe(1);
    const second = pruneToolResults(first.messages, {
      ...DEFAULT_CONFIG,
      pruneProtectTokens: 0,
      pruneMinimumTokens: 0,
      pruneTailTurns: 0,
    });
    expect(second.prunedCount).toBe(0);
  });

  test("selectPruneIndices allocates protection to recent turns before older turns", () => {
    const candidates = [
      { index: 5, tokens: 10_000, turnsFromEnd: 0 },
      { index: 4, tokens: 10_000, turnsFromEnd: 3 },
      { index: 3, tokens: 10_000, turnsFromEnd: 0 },
      { index: 2, tokens: 30_000, turnsFromEnd: 1 },
    ];
    const { toPrune, prunedTokensEst } = selectPruneIndices(candidates, 25_000, 5_000, 2);
    expect(toPrune).toEqual([4]);
    expect(prunedTokensEst).toBe(10_000);
  });

  test("collectPruneCandidates skips protected and errors", () => {
    const messages = [
      { role: "user", content: "u" },
      bigTool("bash", 4_000),
      {
        role: "toolResult",
        toolName: "skill",
        content: [{ type: "text", text: "s".repeat(4_000) }],
        isError: false,
      },
      {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "e".repeat(4_000) }],
      },
    ];
    const c = collectPruneCandidates(messages, ["skill"]);
    expect(c.length).toBe(1);
    expect(c[0].index).toBe(1);
  });
});

describe("stripOverflowMedia", () => {
  test("replaces images on last user message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/jpeg", data: "abc" },
        ],
      },
    ];
    const out = stripOverflowMedia(messages);
    expect(out.stripped).toBe(1);
    expect(out.messages[1].content.some((p: any) => p.type === "image")).toBe(false);
    expect(out.messages[1].content.some((p: any) => String(p.text).includes("overflow"))).toBe(true);
  });
});
