import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 2000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	attempts?: number;
	retries?: number;
	retryReasons?: string[];
	retrying?: boolean;
}

export interface RetryPolicy {
	maxRetries: number;
	retryDelayMs: number;
	maxRetryDelayMs: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: string;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export function createEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function addUsage(target: UsageStats, source: UsageStats): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
	if (source.contextTokens > 0) target.contextTokens = source.contextTokens;
}

export function cloneUsage(usage: UsageStats): UsageStats {
	return { ...usage };
}

export function isFailedResult(result: Pick<SingleResult, "exitCode" | "stopReason">): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function compactRetryReason(reason: string): string {
	const compacted = reason.replace(/\s+/g, " ").trim();
	if (!compacted) return "error";
	return compacted.length > 240 ? `${compacted.slice(0, 237)}...` : compacted;
}

export function getRetryFailureReason(
	result: Pick<SingleResult, "stopReason" | "errorMessage" | "stderr" | "exitCode">,
): string | undefined {
	if (result.stopReason === "aborted") return undefined;
	if (result.stopReason === "error") return compactRetryReason(result.errorMessage || result.stderr || "model error");
	if (result.exitCode !== 0) return compactRetryReason(result.stderr || `exit code ${result.exitCode}`);
	return undefined;
}

export function appendRetryStats(usageStr: string, result: Pick<SingleResult, "retries">): string {
	if (!result.retries || result.retries <= 0) return usageStr;
	const retryStr = `retried ${result.retries} time${result.retries === 1 ? "" : "s"}`;
	return usageStr ? `${usageStr} ${retryStr}` : retryStr;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted"));
	if (ms <= 0) return Promise.resolve();

	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timeout) clearTimeout(timeout);
			reject(new Error("Subagent was aborted"));
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** delay = min(cap, base * 2^retryIndex); retryIndex is 0-based after each failed attempt. */
export function computeRetryDelayMs(policy: RetryPolicy, retryIndex: number): number {
	const base = Math.max(0, policy.retryDelayMs);
	const cap = Math.max(base, Math.max(0, policy.maxRetryDelayMs));
	if (base === 0 || cap === 0) return 0;

	const index = Math.max(0, Math.floor(retryIndex));
	// Multiply iteratively to avoid float Infinity from large exponents.
	let delay = base;
	for (let i = 0; i < index; i++) {
		delay = delay * 2;
		if (delay >= cap) return cap;
	}
	return Math.min(delay, cap);
}

export function buildRetryPolicy(params: {
	maxRetries?: number;
	retryDelayMs?: number;
	maxRetryDelayMs?: number;
}): RetryPolicy {
	const maxRetries = Math.max(0, Math.min(10, Math.floor(params.maxRetries ?? DEFAULT_MAX_RETRIES)));
	const retryDelayMs = Math.max(0, Math.floor(params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
	let maxRetryDelayMs = Math.max(0, Math.floor(params.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS));
	if (maxRetryDelayMs < retryDelayMs) maxRetryDelayMs = retryDelayMs;
	return { maxRetries, retryDelayMs, maxRetryDelayMs };
}

export async function runSingleAgentWithRetries(deps: {
	agentName: string;
	retryPolicy: RetryPolicy;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	runAttempt: (attempt: number) => Promise<{ result: SingleResult; wasAborted: boolean }>;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<SingleResult> {
	const {
		agentName,
		retryPolicy,
		signal,
		onUpdate,
		makeDetails,
		runAttempt,
		sleep = abortableSleep,
	} = deps;

	const cumulativeUsage = createEmptyUsage();
	const retryReasons: string[] = [];

	for (let attempt = 1; ; attempt++) {
		const { result, wasAborted } = await runAttempt(attempt);

		if (wasAborted) throw new Error("Subagent was aborted");

		addUsage(cumulativeUsage, result.usage);
		result.usage = cloneUsage(cumulativeUsage);
		result.attempts = attempt;
		if (attempt > 1) result.retries = attempt - 1;
		if (retryReasons.length > 0) result.retryReasons = [...retryReasons];
		delete result.retrying;

		const retryReason = getRetryFailureReason(result);
		if (!retryReason || attempt - 1 >= retryPolicy.maxRetries) return result;

		retryReasons.push(retryReason);
		const delayMs = computeRetryDelayMs(retryPolicy, attempt - 1);
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: `Retrying ${agentName} after ${retryReason} (retry ${attempt}/${retryPolicy.maxRetries}) in ${delayMs}ms...`,
					},
				],
				details: makeDetails([
					{ ...result, retries: attempt - 1, retryReasons: [...retryReasons], retrying: true },
				]),
			});
		}
		await sleep(delayMs, signal);
	}
}
