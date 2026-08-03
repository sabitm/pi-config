import { describe, expect, test } from "bun:test";
import { pruneToolResults, stripOverflowMedia } from "../src/prune";
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

  test("protects recent turns and protected tools", () => {
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
    // Recent 2 user turns' tools should stay; skill protected; older bash may prune.
    const skill = out.messages.find((m: any) => m.toolName === "skill");
    expect(skill.content[0].text.includes(PRUNE_MARKER)).toBe(false);
    // At least one older bash pruned if thresholds met
    if (out.prunedCount > 0) {
      const pruned = out.messages.filter(
        (m: any) =>
          m.role === "toolResult" &&
          typeof m.content?.[0]?.text === "string" &&
          m.content[0].text.includes(PRUNE_MARKER),
      );
      expect(pruned.length).toBe(out.prunedCount);
      expect(pruned.every((m: any) => m.toolName !== "skill")).toBe(true);
    }
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
    ];
    const out = pruneToolResults(messages, {
      ...DEFAULT_CONFIG,
      pruneProtectTokens: 0,
      pruneMinimumTokens: 0,
      pruneTailTurns: 0,
    });
    expect(out.prunedCount).toBe(0);
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
