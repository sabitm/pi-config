import { describe, expect, test } from "bun:test";
import {
  consumeProactiveResume,
  estimateTokensAfterPrune,
  initialProactiveState,
  isWorkContinuing,
  reduceProactiveState,
  shouldScheduleAutoContinue,
  shouldTriggerProactiveCompact,
} from "../src/proactive";

describe("isWorkContinuing", () => {
  test("true when toolResults present", () => {
    expect(isWorkContinuing({ role: "assistant", content: [] }, [{ role: "toolResult" }])).toBe(
      true,
    );
  });

  test("true when assistant has toolCall blocks", () => {
    expect(
      isWorkContinuing(
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: {} }],
        },
        [],
      ),
    ).toBe(true);
  });

  test("false for plain final assistant text", () => {
    expect(
      isWorkContinuing({ role: "assistant", content: [{ type: "text", text: "done" }] }, []),
    ).toBe(false);
  });
});

describe("estimateTokensAfterPrune", () => {
  test("subtracts savings", () => {
    expect(estimateTokensAfterPrune(100_000, 30_000)).toBe(70_000);
  });

  test("null stays null", () => {
    expect(estimateTokensAfterPrune(null, 10_000)).toBeNull();
  });

  test("floors at zero", () => {
    expect(estimateTokensAfterPrune(5_000, 20_000)).toBe(0);
  });
});

describe("shouldTriggerProactiveCompact", () => {
  const base = {
    workContinuing: true,
    tokensAfterPrune: 190_000,
    contextWindow: 200_000,
    reserveTokens: 16_384,
    alreadyPending: false,
    enabled: true,
  };

  test("triggers near safe threshold while work continues", () => {
    expect(shouldTriggerProactiveCompact(base)).toBe(true);
  });

  test("does not trigger when under threshold", () => {
    expect(shouldTriggerProactiveCompact({ ...base, tokensAfterPrune: 100_000 })).toBe(false);
  });

  test("does not trigger when work is not continuing", () => {
    expect(shouldTriggerProactiveCompact({ ...base, workContinuing: false })).toBe(false);
  });

  test("does not overlap when already pending", () => {
    expect(shouldTriggerProactiveCompact({ ...base, alreadyPending: true })).toBe(false);
  });

  test("disabled config never triggers", () => {
    expect(shouldTriggerProactiveCompact({ ...base, enabled: false })).toBe(false);
  });
});

describe("shouldScheduleAutoContinue", () => {
  test("final successful threshold compaction never schedules continuation", () => {
    expect(
      shouldScheduleAutoContinue({
        autoContinue: true,
        reason: "threshold",
        willRetry: false,
        isTrackedProactive: false,
      }),
    ).toBe(false);
  });

  test("final overflow without willRetry never schedules continuation", () => {
    expect(
      shouldScheduleAutoContinue({
        autoContinue: true,
        reason: "overflow",
        willRetry: false,
        isTrackedProactive: false,
      }),
    ).toBe(false);
  });

  test("willRetry=true never gets duplicate extension continuation", () => {
    expect(
      shouldScheduleAutoContinue({
        autoContinue: true,
        reason: "overflow",
        willRetry: true,
        isTrackedProactive: true,
      }),
    ).toBe(false);
  });

  test("only tracked proactive compaction can resume", () => {
    expect(
      shouldScheduleAutoContinue({
        autoContinue: true,
        reason: "manual",
        willRetry: false,
        isTrackedProactive: true,
      }),
    ).toBe(true);
    expect(
      shouldScheduleAutoContinue({
        autoContinue: true,
        reason: "manual",
        willRetry: false,
        isTrackedProactive: false,
      }),
    ).toBe(false);
  });

  test("autoContinue false blocks proactive resume", () => {
    expect(
      shouldScheduleAutoContinue({
        autoContinue: false,
        reason: "manual",
        willRetry: false,
        isTrackedProactive: true,
      }),
    ).toBe(false);
  });
});

describe("proactive state machine", () => {
  test("repeated turn_end requests cannot overlap", () => {
    let s = initialProactiveState();
    s = reduceProactiveState(s, { type: "request" });
    expect(s.phase).toBe("pending");
    const again = reduceProactiveState(s, { type: "request" });
    expect(again.phase).toBe("pending");
    s = reduceProactiveState(s, { type: "started" });
    expect(s.phase).toBe("compacting");
    const overlap = reduceProactiveState(s, { type: "request" });
    expect(overlap.phase).toBe("compacting");
  });

  test("failed proactive compaction clears state", () => {
    let s = reduceProactiveState(initialProactiveState(), { type: "request" });
    s = reduceProactiveState(s, { type: "started" });
    s = reduceProactiveState(s, { type: "failure" });
    expect(s).toEqual(initialProactiveState());
  });

  test("consumeProactiveResume only when tracked", () => {
    let s = reduceProactiveState(initialProactiveState(), { type: "request" });
    s = reduceProactiveState(s, { type: "started" });
    const { next, shouldResume } = consumeProactiveResume(s);
    expect(shouldResume).toBe(true);
    expect(next).toEqual(initialProactiveState());

    const idle = consumeProactiveResume(initialProactiveState());
    expect(idle.shouldResume).toBe(false);
  });
});
