import { describe, expect, test } from "bun:test";
import { prepareHeadMessages, serializeHead, truncateForSummary } from "../src/serialize";

describe("truncateForSummary", () => {
  test("leaves short text alone", () => {
    expect(truncateForSummary("hello", 100)).toBe("hello");
  });

  test("truncates with marker", () => {
    const out = truncateForSummary("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out.includes("[truncated]")).toBe(true);
  });
});

describe("prepareHeadMessages", () => {
  test("strips images and truncates tool results", () => {
    const { messages, mediaStripped } = prepareHeadMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image", mimeType: "image/png", data: "xxx" },
          ],
        },
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "a".repeat(50) }],
        },
      ],
      { toolOutputMaxChars: 10, stripMedia: true },
    );
    expect(mediaStripped).toBe(1);
    const user = messages[0];
    expect(user.content.some((p: any) => p.type === "text" && p.text.includes("Attached"))).toBe(true);
    expect(user.content.some((p: any) => p.type === "image")).toBe(false);
    const tool = messages[1];
    const text = tool.content[0].text as string;
    expect(text.length).toBeLessThan(50);
    expect(text.includes("[truncated]")).toBe(true);
  });
});

describe("serializeHead", () => {
  test("maps roles", () => {
    const text = serializeHead([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      { role: "toolResult", toolName: "read", content: "file body" },
    ]);
    expect(text).toContain("[User]: hi");
    expect(text).toContain("[Assistant]: ok");
    expect(text).toContain("[Assistant tool call]: read(");
    expect(text).toContain("[Tool result]: file body");
  });
});
