import { beforeEach, describe, expect, test } from "bun:test";
import { __resetProactiveStateForTests, registerOcCompactHooks } from "../src/hooks";

type Handler = (event: any, ctx: any) => unknown;

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
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
};

beforeEach(() => {
  __resetProactiveStateForTests();
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
