// LLM prompts and JSON parsing for row summaries and rollup merges.
import type { Usage } from "@earendil-works/pi-ai";
import { type LeafJob, type MergeJob, mergeShrink } from "./rows.ts";

export const systemPrompt = [
	"You summarize parts of a conversation between a user and an AI coding agent.",
	"Do not continue the conversation. Do not answer questions in it. Output only the JSON object that the request asks for.",
].join("\n");

export type Complete = (system: string, user: string) => Promise<{ text: string; usage?: Usage }>;

const summaryMinChars = 400;
const mergeMinChars = 600;
const summaryMaxChars = 2000;
const goalNowMaxChars = 1500;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

// About 1 summary character for each 100 message characters. A continued row does not shrink.
export function leafLimit(job: LeafJob): number {
	const limit = clamp(jobText(job).length / 100, summaryMinChars, summaryMaxChars);
	return Math.max(limit, Math.min(job.extend?.summary.length ?? 0, summaryMaxChars));
}

export function mergeLimit(job: MergeJob): number {
	return clamp(mergeShrink * (job.a.summary.length + job.b.summary.length), mergeMinChars, summaryMaxChars);
}

export function jobText(job: LeafJob): string {
	return job.group.texts.filter(Boolean).join("\n\n");
}

// Keeps the head and the tail. The request and the result of a span are usually there.
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor(max / 2);
	return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters left out ...]\n${text.slice(-half)}`;
}

export function batchJobs(jobs: LeafJob[], maxChars: number): LeafJob[][] {
	const batches: LeafJob[][] = [];
	let current: LeafJob[] = [];
	let size = 0;
	for (const job of jobs) {
		const length = Math.min(jobText(job).length, maxChars) + (job.extend?.summary.length ?? 0);
		if (current.length > 0 && size + length > maxChars) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(job);
		size += length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export function leafPrompt(jobs: LeafJob[], goalNow: string, maxChars: number, customInstructions?: string): string {
	const lines = [
		"Write a summary for each row below. A row is one user request and the agent work that followed it.",
		"",
		"Rules for a row summary:",
		"- Use at most the max-chars value of the row. Larger rows have more space. Do not pad short rows.",
		"- State the user request, the result, and the key facts: decisions, constraints, file paths, IDs, errors, and numbers.",
		"- Use the space for exact values (versions, hashes, seeds, counts, file paths) and for the reasons for decisions.",
		"- If a row has a previous summary, the row continues. Write one summary that covers the previous summary and the new messages.",
		"- Write only facts that are in the messages.",
		"- Do not copy IDs that start with pending:. They are temporary.",
		"",
		"Then update the goal and current state text. Use exactly these three parts:",
		"Goal: the overall objective, in 1 to 2 sentences.",
		"Constraints: user rules and preferences that apply to future work. Do not include rules that applied only to one finished request.",
		"Now: the current state and the next steps.",
		"Do not list finished requests. The rows record history. Remove items that are done or no longer apply.",
		"Do not copy IDs that start with pending:.",
		`Use at most ${goalNowMaxChars} characters. Keep the text unchanged when nothing changed.`,
	];
	if (customInstructions?.trim()) lines.push("", `Extra focus from the user: ${customInstructions.trim()}`);
	lines.push(
		"",
		"Output exactly one JSON object and nothing else, in this format:",
		`{"rows": {${jobs.map((job) => `"${job.key}": "summary"`).join(", ")}}, "goalNow": "text"}`,
		"",
		"<goal-now>",
		goalNow.trim() || "(none)",
		"</goal-now>",
	);
	for (const job of jobs) {
		lines.push("", `<row key="${job.key}" max-chars="${leafLimit(job)}">`);
		if (job.extend) lines.push("<previous-summary>", job.extend.summary, "</previous-summary>");
		lines.push("<messages>", clipMiddle(jobText(job), maxChars), "</messages>", "</row>");
	}
	return lines.join("\n");
}

export function mergePrompt(jobs: MergeJob[]): string {
	const lines = [
		"Each item below has two summaries of consecutive parts of a conversation, A and then B.",
		"For each item, write one summary that covers both. Use at most the max-chars value of the item.",
		"Keep decisions, constraints, exact values, file paths, IDs, and results. Leave out details that the later part made obsolete.",
		"",
		"Output exactly one JSON object and nothing else, in this format:",
		`{"nodes": {${jobs.map((job) => `"${job.key}": "summary"`).join(", ")}}}`,
	];
	for (const job of jobs) {
		lines.push("", `<item key="${job.key}" max-chars="${mergeLimit(job)}">`, "<a>", job.a.summary, "</a>", "<b>", job.b.summary, "</b>", "</item>");
	}
	return lines.join("\n");
}

function parseObject(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("response has no JSON object");
	const value = JSON.parse(text.slice(start, end + 1));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response JSON is not an object");
	return value as Record<string, unknown>;
}

function readSummaries(map: unknown, keys: string[], field: string): Map<string, string> {
	if (!map || typeof map !== "object") throw new Error(`response has no "${field}" object`);
	const result = new Map<string, string>();
	for (const key of keys) {
		const value = (map as Record<string, unknown>)[key];
		if (typeof value !== "string" || !value.trim()) throw new Error(`response has no summary for ${key}`);
		result.set(key, value.trim());
	}
	return result;
}

export function parseLeafResponse(text: string, keys: string[]): { summaries: Map<string, string>; goalNow: string } {
	const value = parseObject(text);
	if (typeof value.goalNow !== "string") throw new Error('response has no "goalNow" string');
	return { summaries: readSummaries(value.rows, keys, "rows"), goalNow: value.goalNow.trim() };
}

export function parseMergeResponse(text: string, keys: string[]): Map<string, string> {
	return readSummaries(parseObject(text).nodes, keys, "nodes");
}

export function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
	if (!next) return total;
	if (!total) return structuredClone(next);
	return {
		input: total.input + next.input,
		output: total.output + next.output,
		cacheRead: total.cacheRead + next.cacheRead,
		cacheWrite: total.cacheWrite + next.cacheWrite,
		totalTokens: total.totalTokens + next.totalTokens,
		cost: {
			input: total.cost.input + next.cost.input,
			output: total.cost.output + next.cost.output,
			cacheRead: total.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
			total: total.cost.total + next.cost.total,
		},
	};
}

// One retry when the response cannot be parsed. Request errors and aborts are not retried.
export async function completeJson<T>(
	complete: Complete,
	user: string,
	parse: (text: string) => T,
	signal: AbortSignal,
): Promise<{ value: T; usage?: Usage }> {
	let usage: Usage | undefined;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (signal.aborted) throw new Error("aborted");
		const response = await complete(systemPrompt, user);
		usage = addUsage(usage, response.usage);
		try {
			return { value: parse(response.text), usage };
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`summary response is not valid: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
