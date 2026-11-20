// JSON parsing of model responses, with one retry, and usage totals.
import type { Usage } from "@earendil-works/pi-ai";

export type Complete = (system: string, user: string) => Promise<{ text: string; usage?: Usage; stopReason?: string }>;

const systemPrompt = "Output only the JSON object that the request asks for.";

// Index just after the "}" that closes the object opened at start, or -1. Braces inside strings do not count.
function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return i + 1;
	}
	return -1;
}

// Parses the first complete JSON object and ignores text around it, such as a code fence or an extra "}".
export function parseJsonObject(text: string): Record<string, unknown> {
	let lastError: unknown;
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		const end = objectEnd(text, start);
		if (end < 0) break;
		try {
			const value = JSON.parse(text.slice(start, end));
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("response has no JSON object");
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
	let last: Awaited<ReturnType<Complete>> | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (signal.aborted) throw new Error("aborted");
		last = await complete(systemPrompt, user);
		usage = addUsage(usage, last.usage);
		try {
			return { value: parse(last.text), usage };
		} catch (error) {
			lastError = error;
		}
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`response is not valid: ${reason}. ${describeResponse(last!)}`);
}

const edgeChars = 200;

export function describeResponse(response: Awaited<ReturnType<Complete>>): string {
	const text = response.text.replace(/\s+/g, " ").trim();
	const edges = text.length <= 2 * edgeChars ? `text="${text}"` : `start="${text.slice(0, edgeChars)}" end="${text.slice(-edgeChars)}"`;
	return `stop=${response.stopReason ?? "unknown"} output tokens=${response.usage?.output ?? "unknown"} chars=${response.text.length} ${edges}`;
}
