import { describe, expect, test } from "bun:test";
import {
	abortableSleep,
	addUsage,
	appendRetryStats,
	buildRetryPolicy,
	cloneUsage,
	compactRetryReason,
	computeRetryDelayMs,
	createEmptyUsage,
	DEFAULT_MAX_RETRIES,
	DEFAULT_MAX_RETRY_DELAY_MS,
	DEFAULT_RETRY_DELAY_MS,
	getRetryFailureReason,
	isFailedResult,
	type RetryPolicy,
	runSingleAgentWithRetries,
	type SingleResult,
	type SubagentDetails,
} from "../src/retry";

function basePolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
	return {
		maxRetries: DEFAULT_MAX_RETRIES,
		retryDelayMs: DEFAULT_RETRY_DELAY_MS,
		maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
		...overrides,
	};
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "tester",
		agentSource: "user",
		task: "do work",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: createEmptyUsage(),
		...overrides,
	};
}

function makeDetails(_results: SingleResult[]): SubagentDetails {
	return {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: _results,
	};
}

describe("computeRetryDelayMs", () => {
	test("default sequence doubles from base", () => {
		const policy = basePolicy();
		expect(computeRetryDelayMs(policy, 0)).toBe(2000);
		expect(computeRetryDelayMs(policy, 1)).toBe(4000);
		expect(computeRetryDelayMs(policy, 2)).toBe(8000);
	});

	test("caps at maxRetryDelayMs", () => {
		const policy = basePolicy({ retryDelayMs: 1000, maxRetryDelayMs: 3000 });
		expect(computeRetryDelayMs(policy, 0)).toBe(1000);
		expect(computeRetryDelayMs(policy, 1)).toBe(2000);
		expect(computeRetryDelayMs(policy, 2)).toBe(3000);
		expect(computeRetryDelayMs(policy, 3)).toBe(3000);
	});

	test("fixed delay when cap equals base", () => {
		const policy = basePolicy({ retryDelayMs: 2000, maxRetryDelayMs: 2000 });
		expect(computeRetryDelayMs(policy, 0)).toBe(2000);
		expect(computeRetryDelayMs(policy, 1)).toBe(2000);
		expect(computeRetryDelayMs(policy, 5)).toBe(2000);
	});

	test("base 0 yields 0", () => {
		const policy = basePolicy({ retryDelayMs: 0, maxRetryDelayMs: 30000 });
		expect(computeRetryDelayMs(policy, 0)).toBe(0);
		expect(computeRetryDelayMs(policy, 3)).toBe(0);
	});

	test("large index does not yield Infinity or NaN", () => {
		const policy = basePolicy({ retryDelayMs: 2000, maxRetryDelayMs: 30000 });
		const delay = computeRetryDelayMs(policy, 100);
		expect(Number.isFinite(delay)).toBe(true);
		expect(delay).toBe(30000);
	});
});

describe("buildRetryPolicy", () => {
	test("applies defaults", () => {
		expect(buildRetryPolicy({})).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			retryDelayMs: DEFAULT_RETRY_DELAY_MS,
			maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
		});
	});

	test("clamps maxRetries and delays", () => {
		expect(buildRetryPolicy({ maxRetries: 99 }).maxRetries).toBe(10);
		expect(buildRetryPolicy({ maxRetries: -1 }).maxRetries).toBe(0);
		expect(buildRetryPolicy({ maxRetries: 2.7 }).maxRetries).toBe(2);
		expect(buildRetryPolicy({ retryDelayMs: -5 }).retryDelayMs).toBe(0);
		expect(buildRetryPolicy({ maxRetryDelayMs: -1 }).maxRetryDelayMs).toBe(DEFAULT_RETRY_DELAY_MS);
	});

	test("raises cap to at least base", () => {
		const policy = buildRetryPolicy({ retryDelayMs: 5000, maxRetryDelayMs: 1000 });
		expect(policy.retryDelayMs).toBe(5000);
		expect(policy.maxRetryDelayMs).toBe(5000);
	});
});

describe("getRetryFailureReason", () => {
	test("aborted is never retried", () => {
		expect(getRetryFailureReason(makeResult({ stopReason: "aborted", exitCode: 1 }))).toBeUndefined();
	});

	test("error stopReason prefers errorMessage then stderr then fallback", () => {
		expect(getRetryFailureReason(makeResult({ stopReason: "error", errorMessage: "timeout" }))).toBe("timeout");
		expect(getRetryFailureReason(makeResult({ stopReason: "error", stderr: "segfault" }))).toBe("segfault");
		expect(getRetryFailureReason(makeResult({ stopReason: "error" }))).toBe("model error");
	});

	test("nonzero exit uses stderr or exit code", () => {
		expect(getRetryFailureReason(makeResult({ exitCode: 1, stderr: "oops" }))).toBe("oops");
		expect(getRetryFailureReason(makeResult({ exitCode: 137 }))).toBe("exit code 137");
	});

	test("success returns undefined", () => {
		expect(getRetryFailureReason(makeResult({ exitCode: 0, stopReason: "end" }))).toBeUndefined();
	});
});

describe("compactRetryReason", () => {
	test("collapses whitespace", () => {
		expect(compactRetryReason("too  many\n\tspaces")).toBe("too many spaces");
	});

	test("truncates at 240 chars", () => {
		const long = "x".repeat(300);
		const out = compactRetryReason(long);
		expect(out.length).toBe(240);
		expect(out.endsWith("...")).toBe(true);
	});

	test("empty becomes error", () => {
		expect(compactRetryReason("")).toBe("error");
		expect(compactRetryReason("   ")).toBe("error");
	});
});

describe("usage helpers", () => {
	test("addUsage sums and last-wins contextTokens", () => {
		const target = createEmptyUsage();
		addUsage(target, { ...createEmptyUsage(), input: 10, turns: 1, contextTokens: 100 });
		addUsage(target, { ...createEmptyUsage(), input: 20, turns: 2, contextTokens: 250 });
		expect(target.input).toBe(30);
		expect(target.turns).toBe(3);
		expect(target.contextTokens).toBe(250);
	});

	test("cloneUsage breaks aliasing", () => {
		const original = createEmptyUsage();
		original.input = 5;
		const cloned = cloneUsage(original);
		cloned.input = 99;
		expect(original.input).toBe(5);
	});
});

describe("appendRetryStats", () => {
	test("formats singular plural and empty usage", () => {
		expect(appendRetryStats("↑1k", { retries: 0 })).toBe("↑1k");
		expect(appendRetryStats("↑1k", {})).toBe("↑1k");
		expect(appendRetryStats("↑1k", { retries: 1 })).toBe("↑1k retried 1 time");
		expect(appendRetryStats("↑1k", { retries: 3 })).toBe("↑1k retried 3 times");
		expect(appendRetryStats("", { retries: 2 })).toBe("retried 2 times");
	});
});

describe("isFailedResult", () => {
	test("classifies exit and stop reasons", () => {
		expect(isFailedResult({ exitCode: 0 })).toBe(false);
		expect(isFailedResult({ exitCode: 1 })).toBe(true);
		expect(isFailedResult({ exitCode: 0, stopReason: "error" })).toBe(true);
		expect(isFailedResult({ exitCode: 0, stopReason: "aborted" })).toBe(true);
	});
});

describe("abortableSleep", () => {
	test("ms <= 0 resolves immediately", async () => {
		const start = Date.now();
		await abortableSleep(0);
		expect(Date.now() - start).toBeLessThan(50);
	});

	test("pre-aborted signal rejects", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(abortableSleep(100, controller.signal)).rejects.toThrow("Subagent was aborted");
	});

	test("abort mid-sleep rejects promptly", async () => {
		const controller = new AbortController();
		const pending = abortableSleep(500, controller.signal);
		setTimeout(() => controller.abort(), 20);
		const start = Date.now();
		await expect(pending).rejects.toThrow("Subagent was aborted");
		expect(Date.now() - start).toBeLessThan(200);
	});

	test("resolved sleep ignores later abort", async () => {
		const controller = new AbortController();
		await abortableSleep(10, controller.signal);
		controller.abort();
	});
});

describe("runSingleAgentWithRetries", () => {
	test("success on first attempt does not sleep", async () => {
		const sleeps: number[] = [];
		const result = await runSingleAgentWithRetries({
			agentName: "tester",
			retryPolicy: basePolicy(),
			makeDetails,
			runAttempt: async () => ({
				result: makeResult({ usage: { ...createEmptyUsage(), input: 7 } }),
				wasAborted: false,
			}),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(result.attempts).toBe(1);
		expect(result.retries).toBeUndefined();
		expect(result.retrying).toBeUndefined();
		expect(result.usage.input).toBe(7);
		expect(sleeps).toEqual([]);
	});

	test("fail then success sleeps base delay once", async () => {
		const sleeps: number[] = [];
		const updates: Array<{ text: string; retries?: number; retrying?: boolean }> = [];
		let call = 0;
		const result = await runSingleAgentWithRetries({
			agentName: "tester",
			retryPolicy: basePolicy({ maxRetries: 3 }),
			makeDetails,
			onUpdate: (partial) => {
				const r = partial.details?.results[0];
				const text = partial.content[0]?.type === "text" ? partial.content[0].text : "";
				updates.push({ text, retries: r?.retries, retrying: r?.retrying });
			},
			runAttempt: async () => {
				call++;
				if (call === 1) {
					return {
						result: makeResult({
							exitCode: 1,
							stderr: "boom",
							usage: { ...createEmptyUsage(), input: 10 },
						}),
						wasAborted: false,
					};
				}
				return {
					result: makeResult({ usage: { ...createEmptyUsage(), input: 20 } }),
					wasAborted: false,
				};
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(result.attempts).toBe(2);
		expect(result.retries).toBe(1);
		expect(result.retryReasons).toEqual(["boom"]);
		expect(result.retrying).toBeUndefined();
		expect(result.usage.input).toBe(30);
		expect(sleeps).toEqual([2000]);
		expect(updates.some((u) => u.retrying === true && u.retries === 0)).toBe(true);
		expect(updates.some((u) => u.text.includes("in 2000ms") && u.text.includes("retry 1/3"))).toBe(true);
	});

	test("maxRetries 0 returns first failure without sleep", async () => {
		const sleeps: number[] = [];
		const result = await runSingleAgentWithRetries({
			agentName: "tester",
			retryPolicy: basePolicy({ maxRetries: 0 }),
			makeDetails,
			runAttempt: async () => ({
				result: makeResult({ exitCode: 1, stderr: "nope" }),
				wasAborted: false,
			}),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(result.attempts).toBe(1);
		expect(result.retries).toBeUndefined();
		expect(sleeps).toEqual([]);
	});

	test("exhausts retries with exponential sleep sequence", async () => {
		const sleeps: number[] = [];
		const result = await runSingleAgentWithRetries({
			agentName: "tester",
			retryPolicy: basePolicy({ maxRetries: 2, retryDelayMs: 2000, maxRetryDelayMs: 30000 }),
			makeDetails,
			runAttempt: async () => ({
				result: makeResult({ exitCode: 1, stderr: "fail" }),
				wasAborted: false,
			}),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(result.attempts).toBe(3);
		expect(result.retries).toBe(2);
		expect(result.retryReasons).toEqual(["fail", "fail"]);
		expect(sleeps).toEqual([2000, 4000]);
	});

	test("capped backoff sequence", async () => {
		const sleeps: number[] = [];
		await runSingleAgentWithRetries({
			agentName: "tester",
			retryPolicy: basePolicy({ maxRetries: 3, retryDelayMs: 1000, maxRetryDelayMs: 3000 }),
			makeDetails,
			runAttempt: async () => ({
				result: makeResult({ exitCode: 1, stderr: "x" }),
				wasAborted: false,
			}),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(sleeps).toEqual([1000, 2000, 3000]);
	});

	test("wasAborted throws without retry", async () => {
		const sleeps: number[] = [];
		await expect(
			runSingleAgentWithRetries({
				agentName: "tester",
				retryPolicy: basePolicy(),
				makeDetails,
				runAttempt: async () => ({
					result: makeResult({ exitCode: 1 }),
					wasAborted: true,
				}),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		).rejects.toThrow("Subagent was aborted");
		expect(sleeps).toEqual([]);
	});

	test("abort during sleep propagates", async () => {
		const controller = new AbortController();
		await expect(
			runSingleAgentWithRetries({
				agentName: "tester",
				retryPolicy: basePolicy({ maxRetries: 2 }),
				signal: controller.signal,
				makeDetails,
				runAttempt: async () => ({
					result: makeResult({ exitCode: 1, stderr: "temp" }),
					wasAborted: false,
				}),
				sleep: async (_ms, signal) => {
					controller.abort();
					if (signal?.aborted) throw new Error("Subagent was aborted");
				},
			}),
		).rejects.toThrow("Subagent was aborted");
	});

	test("retry onUpdate uses attempt-1 retries and copies reasons", async () => {
		const snapshots: SingleResult[] = [];
		let call = 0;
		await runSingleAgentWithRetries({
			agentName: "tester",
			retryPolicy: basePolicy({ maxRetries: 2 }),
			makeDetails,
			onUpdate: (partial) => {
				const r = partial.details?.results[0];
				if (r?.retrying) snapshots.push(r);
			},
			runAttempt: async () => {
				call++;
				if (call < 3) {
					return {
						result: makeResult({ exitCode: 1, stderr: `e${call}` }),
						wasAborted: false,
					};
				}
				return { result: makeResult(), wasAborted: false };
			},
			sleep: async () => {},
		});
		expect(snapshots.length).toBe(2);
		expect(snapshots[0].retries).toBe(0);
		expect(snapshots[0].retryReasons).toEqual(["e1"]);
		expect(snapshots[1].retries).toBe(1);
		expect(snapshots[1].retryReasons).toEqual(["e1", "e2"]);
		// Copies, not shared mutable refs across updates
		expect(snapshots[0].retryReasons).not.toBe(snapshots[1].retryReasons);
	});
});
