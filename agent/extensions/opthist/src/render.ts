// Message text, row parts, and the compaction note. No Pi imports.

export const rowSummaryToolName = "row_summary";
export const pageToolName = "history_page";
export const openToolName = "history_open";
export const summaryMaxChars = 1500;
export const rowSummaryGuideline = `Before your final answer to each user request, call ${rowSummaryToolName} once. Write: the request, what you did, the results, exact values (paths, versions, numbers, names), and decisions with their reasons. At most ${summaryMaxChars} characters.`;
const historyTools = new Set([pageToolName, openToolName]);

type Part = { type: string; text?: string; name?: string; arguments?: unknown };
export type Message = {
	role: string;
	content?: string | Part[];
	toolName?: string;
	command?: string;
	output?: string;
	summary?: string;
	customType?: string;
	nestedCalls?: { calls?: { name?: string; arguments?: unknown }[] };
};

export interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export interface FileOp {
	path: string;
	modified: boolean;
}

function fileOp(name: string | undefined, args: unknown): FileOp | undefined {
	const path = (args as { path?: unknown } | undefined)?.path;
	if (typeof path !== "string" || !path) return undefined;
	if (name === "read") return { path, modified: false };
	if (name === "write" || name === "edit") return { path, modified: true };
	return undefined;
}

// Same rule as Pi's default compaction: read, write, and edit tool calls, including calls from codemode scripts.
export function fileOpsOf(message: Message): FileOp[] {
	let calls: { name?: string; arguments?: unknown }[] = [];
	if (message.role === "assistant" && Array.isArray(message.content)) calls = message.content.filter((part) => part.type === "toolCall");
	else if (message.role === "toolResult") calls = message.nestedCalls?.calls ?? [];
	return calls.map((call) => fileOp(call.name, call.arguments)).filter((op): op is FileOp => op !== undefined);
}

function partsText(content: string | Part[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function clip(text: string, max: number | undefined): string {
	if (max === undefined || text.length <= max) return text;
	return `${text.slice(0, max)}\n[... ${text.length - max} more characters]`;
}

export const userPrefix = "[User]: ";

// toolResultMax undefined keeps tool results in full. Thinking blocks and history tool output are always left out.
export function serializeMessage(message: Message, toolResultMax?: number): string {
	switch (message.role) {
		case "user":
			return `${userPrefix}${partsText(message.content)}`;
		case "assistant": {
			const parts = Array.isArray(message.content) ? message.content : [];
			const lines: string[] = [];
			const text = partsText(parts.filter((part) => part.type === "text"));
			if (text) lines.push(`[Assistant]: ${text}`);
			const calls = parts
				.filter((part) => part.type === "toolCall")
				.map((part) => `${part.name}(${JSON.stringify(part.arguments ?? {})})`);
			if (calls.length > 0) lines.push(`[Assistant tool calls]: ${calls.join("; ")}`);
			return lines.join("\n");
		}
		case "toolResult":
			// History tool output is a copy of older rows, which stay in the database. Keeping it would make
			// history_open show the same messages twice.
			if (historyTools.has(message.toolName ?? "")) return `[Tool result ${message.toolName}]: [history output omitted]`;
			return `[Tool result ${message.toolName ?? ""}]: ${clip(partsText(message.content), toolResultMax)}`;
		case "bashExecution":
			return `[User bash]: ${message.command ?? ""}\n${clip(message.output ?? "", toolResultMax)}`;
		case "custom":
			return `[Message ${message.customType ?? ""}]: ${partsText(message.content)}`;
		case "branchSummary":
			return `[Branch summary]: ${message.summary ?? ""}`;
		default:
			return "";
	}
}

export type Edits = Map<string, { content: unknown } | null>;

export function contextEdits(entries: Entry[]): Edits {
	const edits: Edits = new Map();
	for (const entry of entries) if (entry.type === "context_edit") edits.set(entry.targetId as string, entry.replacement as { content: unknown } | null);
	return edits;
}

// Applies context_edit entries the same way Pi builds model context: null omits, a value replaces content.
export function entryMessage(entry: Entry, edits: Edits): Message | undefined {
	let message: Message;
	if (entry.type === "message") message = entry.message as Message;
	else if (entry.type === "custom_message") message = { role: "custom", customType: entry.customType as string, content: entry.content as Message["content"] };
	else if (entry.type === "branch_summary") message = { role: "branchSummary", summary: entry.summary as string };
	else return undefined;
	if (message.role === "system") return undefined;
	const edit = edits.get(entry.id);
	if (edit === null) return undefined;
	return edit ? { ...message, content: edit.content as Message["content"] } : message;
}

// Text for the entries.text column. It ignores context edits, so direct SQL sees the original content.
export function entryText(entry: Entry): string {
	if (entry.type === "compaction") return `[Compaction summary]: ${entry.summary ?? ""}`;
	const message = entryMessage(entry, new Map());
	return message ? serializeMessage(message) : "";
}

export const isUserStart = (entry: Entry) => entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user";

export function paginate(text: string, pageChars: number): string[] {
	if (text.length === 0) return [""];
	const pages: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + pageChars, text.length);
		// Prefer to cut at a line break in the last quarter of the page.
		if (end < text.length) {
			const newline = text.lastIndexOf("\n", end);
			if (newline > start + pageChars * 0.75) end = newline + 1;
		}
		pages.push(text.slice(start, end));
		start = end;
	}
	return pages;
}

export const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

// The text has no counts, so it stays the same for the whole session and does not break the prompt cache.
export function noteText(path: string): string {
	return [
		"## Full history",
		`Your full history is in the SQLite database ${path}. It is the single source of truth: it has every message of this session, also the messages before this summary. The summary above is incomplete.`,
		`- ${pageToolName} shows row summaries, 20 rows per page. A row is one user request and the work done for it. With no page, it shows the newest page. Read pages from the newest to the oldest until you have what you need.`,
		`- ${openToolName} shows the raw messages of one row. Use it when a summary is not enough.`,
		`- If these tools are not enough, query the database directly, for example: sqlite3 ${path} "SELECT ...". Tables: entries, row_summaries. Views: branch (entries on the current branch), rows (one line for each row, with its summary).`,
	].join("\n");
}

// Adds the note to every compaction summary message. Returns undefined when there is none, so Pi keeps the messages.
export function addNote<T extends { role: string }>(messages: T[], path: string): T[] | undefined {
	if (!messages.some((message) => message.role === "compactionSummary")) return undefined;
	const note = noteText(path);
	return messages.map((message) => {
		if (message.role !== "compactionSummary") return message;
		const summary = (message as { summary?: string }).summary ?? "";
		return { ...message, summary: `${summary}\n\n${note}` };
	});
}
