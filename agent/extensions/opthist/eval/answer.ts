// Answer and judge prompts, and their JSON parsing. No Pi imports.
import { serializeMessage } from "../src/render.ts";
import { parseJsonObject } from "../src/llm.ts";
import { grades, type Asked, type Grade } from "./report.ts";

const toolResultMaxChars = 2000;

type LooseMessage = Parameters<typeof serializeMessage>[0] & { summary?: string };

// The context the agent sees right after compaction: the summary message and the kept messages.
export function renderContext(messages: unknown[]): string {
	return (messages as LooseMessage[])
		.filter((message) => message.role !== "system")
		.map((message) =>
			message.role === "compactionSummary" ? `[Compaction summary]:\n${message.summary ?? ""}` : serializeMessage(message, toolResultMaxChars),
		)
		.filter(Boolean)
		.join("\n\n");
}

export function answerSystemPrompt(withHistory: boolean, guidelines: string[] = []): string {
	return [
		"You are an AI coding agent. Your earlier conversation was compacted. The context in the user message is everything you can see now.",
		...(withHistory
			? [
					"Answer each question from this context and from the history database that the compaction summary describes.",
					"There is no shell. The sql tool runs one read-only SQL query on that database and replaces sqlite3.",
					...guidelines,
				]
			: ["Answer each question from this context only."]),
		"For a yes/no question, start with the word that answers it (Yes or No), and do not contradict it after.",
		withHistory ? "If you cannot find the answer, answer exactly: unknown. Do not guess." : "If the context does not contain the answer, answer exactly: unknown. Do not guess.",
		'Output only one JSON object and nothing else: {"answers": {"<question id>": "<answer>"}}',
	].join("\n");
}

export function answerUserPrompt(context: string, asked: Asked[]): string {
	return [
		"<context>",
		context,
		"</context>",
		"",
		"Questions:",
		...asked.map(({ question }) => `- ${question.id}: ${question.question}`),
	].join("\n");
}

export function judgePrompt(items: { asked: Asked; answer: string }[]): string {
	const lines = [
		"Grade each given answer against the expected answer.",
		"- correct: the same meaning, with all key facts of the expected answer.",
		"- partial: some key facts are right, and nothing contradicts the expected answer.",
		"- wrong: it contradicts the expected answer or states wrong facts.",
		"- unknown: it says unknown, or gives no answer.",
		"Wording can differ. Judge only the facts.",
		"",
		'Output only one JSON object and nothing else: {"grades": {"<id>": {"grade": "correct|partial|wrong|unknown", "reason": "<one sentence>"}}}',
	];
	for (const { asked, answer } of items) {
		lines.push(
			"",
			`<item id="${asked.question.id}">`,
			`<question>${asked.question.question}</question>`,
			`<expected>${asked.question.answer}</expected>`,
			`<given>${answer}</given>`,
			"</item>",
		);
	}
	return lines.join("\n");
}

export const judgeSystemPrompt = "You grade answers against expected answers. Output only the JSON object that the request asks for.";


export function parseAnswers(text: string, ids: string[]): Map<string, string> {
	const answers = parseJsonObject(text).answers;
	if (!answers || typeof answers !== "object") throw new Error('response has no "answers" object');
	const result = new Map<string, string>();
	for (const id of ids) {
		const value = (answers as Record<string, unknown>)[id];
		// A missing answer is an honest gap, not a parse failure.
		result.set(id, typeof value === "string" && value.trim() ? value.trim() : "unknown");
	}
	return result;
}

export function parseGrades(text: string, ids: string[]): Map<string, { grade: Grade; reason: string }> {
	const map = parseJsonObject(text).grades;
	if (!map || typeof map !== "object") throw new Error('response has no "grades" object');
	const result = new Map<string, { grade: Grade; reason: string }>();
	for (const id of ids) {
		const value = (map as Record<string, { grade?: unknown; reason?: unknown }>)[id];
		if (!grades.includes(value?.grade as Grade)) throw new Error(`response has no valid grade for ${id}`);
		result.set(id, { grade: value.grade as Grade, reason: typeof value.reason === "string" ? value.reason : "" });
	}
	return result;
}
