import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";
import { estimateContextTokensLocal, shouldPruneThisRequest } from "../src/prune";

const prevConfigPath = process.env.PI_OC_COMPACT_CONFIG_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.PI_OC_COMPACT_CONFIG_PATH;
  else process.env.PI_OC_COMPACT_CONFIG_PATH = prevConfigPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const writeConfig = (raw: unknown): void => {
  const dir = mkdtempSync(join(tmpdir(), "oc-compact-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(raw));
  process.env.PI_OC_COMPACT_CONFIG_PATH = path;
};

describe("shouldPruneThisRequest", () => {
  const base = {
    trigger: "pressure" as const,
    ratio: null,
    contextWindow: 1000,
    reserveTokens: 200,
    contextEstimate: 0,
    engaged: false,
  };

  test("always-trigger is true regardless of pressure", () => {
    expect(
      shouldPruneThisRequest({
        ...base,
        trigger: "always",
        contextEstimate: 0,
        engaged: false,
        contextWindow: null,
      }),
    ).toBe(true);
    expect(
      shouldPruneThisRequest({
        ...base,
        trigger: "always",
        contextEstimate: 1,
        contextWindow: 1_000_000,
        reserveTokens: 0,
      }),
    ).toBe(true);
  });

  test("unknown or non-positive window fails safe to prune", () => {
    expect(shouldPruneThisRequest({ ...base, contextWindow: null })).toBe(true);
    expect(shouldPruneThisRequest({ ...base, contextWindow: 0 })).toBe(true);
    expect(shouldPruneThisRequest({ ...base, contextWindow: -10 })).toBe(true);
  });

  test("disengaged stays off below threshold and engages above it", () => {
    expect(shouldPruneThisRequest({ ...base, contextEstimate: 800 })).toBe(false);
    expect(shouldPruneThisRequest({ ...base, contextEstimate: 801 })).toBe(true);
  });

  test("engaged latch stays on below threshold", () => {
    expect(shouldPruneThisRequest({ ...base, engaged: true, contextEstimate: 0 })).toBe(true);
  });

  test("explicit ratio uses window * ratio instead of window - reserve", () => {
    expect(
      shouldPruneThisRequest({
        ...base,
        ratio: 0.75,
        contextWindow: 1000,
        reserveTokens: 200,
        contextEstimate: 750,
      }),
    ).toBe(false);
    expect(
      shouldPruneThisRequest({
        ...base,
        ratio: 0.75,
        contextWindow: 1000,
        reserveTokens: 200,
        contextEstimate: 751,
      }),
    ).toBe(true);
    expect(
      shouldPruneThisRequest({
        ...base,
        ratio: null,
        contextWindow: 1000,
        reserveTokens: 200,
        contextEstimate: 800,
      }),
    ).toBe(false);
    expect(
      shouldPruneThisRequest({
        ...base,
        ratio: null,
        contextWindow: 1000,
        reserveTokens: 200,
        contextEstimate: 801,
      }),
    ).toBe(true);
  });
});

describe("estimateContextTokensLocal", () => {
  test("uses last valid usage totalTokens plus trailing estimates", () => {
    const trailing = { role: "user", content: "hello world" };
    const messages = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        usage: { totalTokens: 40, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      trailing,
    ];
    expect(estimateContextTokensLocal(messages)).toBe(40 + estimateTokens(trailing));
  });

  test("falls back to summing estimateTokens when no usage exists", () => {
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ];
    const expected = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    expect(estimateContextTokensLocal(messages)).toBe(expected);
  });

  test("skips aborted, error, and all-zero usage", () => {
    const trailing = { role: "user", content: "after" };
    const zero = {
      role: "assistant",
      content: [{ type: "text", text: "zero" }],
      usage: { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const aborted = {
      role: "assistant",
      content: [{ type: "text", text: "aborted" }],
      stopReason: "aborted",
      usage: { totalTokens: 90, input: 80, output: 10, cacheRead: 0, cacheWrite: 0 },
    };
    const errored = {
      role: "assistant",
      content: [{ type: "text", text: "error" }],
      stopReason: "error",
      usage: { totalTokens: 90, input: 80, output: 10, cacheRead: 0, cacheWrite: 0 },
    };
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { totalTokens: 25, input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      zero,
      aborted,
      errored,
      trailing,
    ];
    expect(estimateContextTokensLocal(messages)).toBe(
      25 +
        estimateTokens(zero) +
        estimateTokens(aborted) +
        estimateTokens(errored) +
        estimateTokens(trailing),
    );
    expect(estimateContextTokensLocal([zero, aborted, errored, trailing])).toBe(
      estimateTokens(zero) + estimateTokens(aborted) + estimateTokens(errored) + estimateTokens(trailing),
    );
  });

  test("sums component usage fields when totalTokens is missing", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 },
      },
    ];
    expect(estimateContextTokensLocal(messages)).toBe(19);
  });
});

describe("config parsing", () => {
  test("defaults are pressure with null ratio", () => {
    expect(DEFAULT_CONFIG.pruneTrigger).toBe("pressure");
    expect(DEFAULT_CONFIG.prunePressureRatio).toBeNull();
    writeConfig({});
    const config = loadConfig();
    expect(config.pruneTrigger).toBe("pressure");
    expect(config.prunePressureRatio).toBeNull();
  });

  test("unknown trigger string falls back to pressure", () => {
    writeConfig({ pruneTrigger: "sometimes" });
    expect(loadConfig().pruneTrigger).toBe("pressure");
  });

  test("accepts always trigger and clamps or rejects ratio", () => {
    writeConfig({ pruneTrigger: "always", prunePressureRatio: 0.75 });
    expect(loadConfig().pruneTrigger).toBe("always");
    expect(loadConfig().prunePressureRatio).toBe(0.75);

    writeConfig({ prunePressureRatio: 1.5 });
    expect(loadConfig().prunePressureRatio).toBe(1);

    writeConfig({ prunePressureRatio: 0 });
    expect(loadConfig().prunePressureRatio).toBeNull();

    writeConfig({ prunePressureRatio: Number.NaN });
    expect(loadConfig().prunePressureRatio).toBeNull();

    writeConfig({ prunePressureRatio: "0.75" });
    expect(loadConfig().prunePressureRatio).toBeNull();

    writeConfig({ prunePressureRatio: null });
    expect(loadConfig().prunePressureRatio).toBeNull();
  });
});
