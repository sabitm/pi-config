import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_CONFIG } from "../src/config";
import {
  __resetProactiveStateForTests,
  __setPendingOverflowStripForTests,
  registerOcCompactHooks,
} from "../src/hooks";
import { PRUNE_MARKER } from "../src/serialize";

type Handler = (event: any, ctx: any) => unknown;

const prevConfigPath = process.env.PI_OC_COMPACT_CONFIG_PATH;
const tempDirs: string[] = [];

const writeConfig = (overrides: Record<string, unknown> = {}): void => {
  const dir = mkdtempSync(join(tmpdir(), "oc-compact-hooks-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }));
  process.env.PI_OC_COMPACT_CONFIG_PATH = path;
};

const setup = () => {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    async sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  } as any;
  registerOcCompactHooks(pi);
  return {
    sent,
    async emit(name: string, event: any, ctx: any = {}) {
      let last: unknown;
      for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx);
      return last;
    },
  };
};

const prunableMessages = () => {
  const messages: any[] = [{ role: "user", content: "research" }];
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { i } }],
    });
    messages.push({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(100_000) }],
      isError: false,
    });
  }
  return messages;
};

const prunedCount = (messages: any[]): number =>
  messages.filter(
    (m: any) =>
      m.role === "toolResult" &&
      typeof m.content?.[0]?.text === "string" &&
      m.content[0].text.includes(PRUNE_MARKER),
  ).length;

beforeEach(() => {
  __resetProactiveStateForTests();
});

afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.PI_OC_COMPACT_CONFIG_PATH;
  else process.env.PI_OC_COMPACT_CONFIG_PATH = prevConfigPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("oc-compact hook continuation lifecycle", () => {
  test("completed threshold compaction does not restart the model", async () => {
    const harness = setup();
    await harness.emit(
      "session_compact",
      { fromExtension: true, reason: "threshold", willRetry: false },
      {},
    );
    await Bun.sleep(5);
    expect(harness.sent).toHaveLength(0);
  });

  test("tracked proactive compaction resumes only after compact onComplete", async () => {
    const harness = setup();
    let compactOptions: any;
    const ctx = {
      getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000 }),
      sessionManager: { getBranch: () => [] },
      compact(options: any) {
        compactOptions = options;
      },
      ui: { notify() {} },
    };

    await harness.emit(
      "turn_end",
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: {} }],
        },
        toolResults: [{ role: "toolResult", toolName: "bash", content: "done" }],
      },
      ctx,
    );
    expect(compactOptions).toBeDefined();

    await harness.emit(
      "session_compact",
      { fromExtension: true, reason: "manual", willRetry: false },
      ctx,
    );
    await Bun.sleep(5);
    expect(harness.sent).toHaveLength(0);

    compactOptions.onComplete({});
    await Bun.sleep(5);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].options).toEqual({ triggerTurn: true });
  });
});

describe("oc-compact context prune gate", () => {
  test("returns unchanged messages when disengaged and below threshold", async () => {
    writeConfig({ pruneTrigger: "pressure", prunePressureRatio: null });
    const harness = setup();
    const messages = prunableMessages();
    const result = await harness.emit(
      "context",
      { messages },
      { getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000_000 }) },
    );
    expect(result).toBeUndefined();
    expect(prunedCount(messages)).toBe(0);
  });

  test("engages and prunes when estimate is above threshold", async () => {
    writeConfig({ pruneTrigger: "pressure", prunePressureRatio: null });
    const harness = setup();
    const messages = prunableMessages();
    const result = (await harness.emit(
      "context",
      { messages },
      { getContextUsage: () => ({ tokens: 40_000, contextWindow: 50_000 }) },
    )) as { messages: any[] } | undefined;
    expect(result?.messages).toBeDefined();
    expect(prunedCount(result!.messages)).toBeGreaterThan(0);
    expect(prunedCount(messages)).toBe(0);
  });

  test("stays latched after a below-threshold follow-up request", async () => {
    writeConfig({ pruneTrigger: "pressure", prunePressureRatio: null });
    const harness = setup();
    const first = (await harness.emit(
      "context",
      { messages: prunableMessages() },
      { getContextUsage: () => ({ tokens: 40_000, contextWindow: 50_000 }) },
    )) as { messages: any[] } | undefined;
    expect(prunedCount(first!.messages)).toBeGreaterThan(0);

    const followUp = [
      ...prunableMessages(),
      {
        role: "assistant",
        content: [{ type: "text", text: "later" }],
        usage: { totalTokens: 100, input: 80, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    const second = (await harness.emit(
      "context",
      { messages: followUp },
      { getContextUsage: () => ({ tokens: 100, contextWindow: 10_000_000 }) },
    )) as { messages: any[] } | undefined;
    expect(prunedCount(second!.messages)).toBeGreaterThan(0);
  });

  test("overflow media strip still applies while prune is gated off", async () => {
    writeConfig({ pruneTrigger: "pressure", prunePressureRatio: null });
    const harness = setup();
    __setPendingOverflowStripForTests(true);
    const messages = [
      ...prunableMessages(),
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/jpeg", data: "abc" },
        ],
      },
    ];
    const result = (await harness.emit(
      "context",
      { messages },
      { getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000_000 }) },
    )) as { messages: any[] } | undefined;
    expect(result?.messages).toBeDefined();
    expect(prunedCount(result!.messages)).toBe(0);
    const last = result!.messages[result!.messages.length - 1];
    expect(last.content.some((p: any) => p.type === "image")).toBe(false);
    expect(last.content.some((p: any) => String(p.text).includes("overflow"))).toBe(true);
  });

  test("session_compact clears the latch so later low-pressure turns skip prune", async () => {
    writeConfig({ pruneTrigger: "pressure", prunePressureRatio: null });
    const harness = setup();
    const first = (await harness.emit(
      "context",
      { messages: prunableMessages() },
      { getContextUsage: () => ({ tokens: 40_000, contextWindow: 50_000 }) },
    )) as { messages: any[] } | undefined;
    expect(prunedCount(first!.messages)).toBeGreaterThan(0);

    await harness.emit("session_compact", { fromExtension: true }, {});

    const result = await harness.emit(
      "context",
      { messages: prunableMessages() },
      { getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000_000 }) },
    );
    expect(result).toBeUndefined();
  });
});
