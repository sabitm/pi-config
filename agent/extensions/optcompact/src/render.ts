// Text rendering for the compaction summary, zoom output, and message serialization. No Pi imports.
import { type FileOp, labelOf, type Pin, type RowNode, type State } from "./rows.ts";

export const zoomToolName = "zoom";
const readFileLimit = 100;

type Part = { type: string; text?: string; name?: string; arguments?: unknown };
type Message = {
	role: string;
	content?: string | Part[];
	toolName?: string;
	command?: string;
	output?: string;
	summary?: string;
	customType?: string;
	nestedCalls?: { calls?: { name?: string; arguments?: unknown }[] };
};

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

export function renderFiles(state: State): string {
	const modified = state.modifiedFiles ?? [];
	const modifiedSet = new Set(modified);
	const readOnly = (state.readFiles ?? []).filter((path) => !modifiedSet.has(path));
	const shown = readOnly.slice(-readFileLimit).sort();
	const hidden = readOnly.length - shown.length;
	const sections: string[] = [];
	if (shown.length > 0) {
		sections.push(`<read-files>\n${shown.join("\n")}\n</read-files>`);
		if (hidden > 0) sections.push(`${hidden} older read-only files not listed.`);
	}
	if (modified.length > 0) sections.push(`<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`);
	return sections.join("\n\n");
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

// toolResultMax undefined keeps tool results in full (zoom). Thinking blocks are always left out.
export function serializeMessage(message: Message, toolResultMax?: number): string {
	switch (message.role) {
		case "user":
			return `[User]: ${partsText(message.content)}`;
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
			// Zoom output is a copy of older rows. Summarizing it again would grow the summary on every zoom.
			if (message.toolName === zoomToolName && toolResultMax !== undefined) return "[Tool result]: [zoom output omitted]";
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

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

const header = [
	"This summary replaces the earlier conversation. It is an index of rows.",
	"A row is one user request and the work done for it. #N is one row. #A-B is a group of rows A to B.",
	`Use the ${zoomToolName} tool with a row ID when a summary is not enough: a group shows its two halves, and one row shows its full messages.`,
	"Use the pin tool to keep an important row in the Pinned section. Use unpin to remove it.",
].join("\n");

export function renderSummary(state: State, pins: Pin[]): string {
	const sections = [header, "## Goal and current state", state.goalNow.trim() || "(none)"];
	sections.push("## Pinned");
	if (pins.length === 0) sections.push("(none)");
	else
		sections.push(
			[
				"Unpin a row when its reason no longer applies, for example when the approved work is finished.",
				...pins.map((pin) =>
					pin.node
						? `- ${pin.label}: ${oneLine(pin.node.summary)}\n  Pinned because: ${oneLine(pin.reason)}`
						: `- ${pin.label} (not yet summarized, in the messages below)\n  Pinned because: ${oneLine(pin.reason)}`,
				),
			].join("\n"),
		);
	sections.push("## Rows");
	const pinnedNodes = pins.flatMap((pin) => (pin.node ? [pin.node] : []));
	const pinned = new Set(pinnedNodes.map(labelOf));
	if (state.nodes.length === 0) sections.push("(none)");
	else
		sections.push(
			state.nodes
				.map((node) => {
					const label = labelOf(node);
					const body = pinned.has(label) ? "(pinned, see Pinned above)" : oneLine(node.summary);
					const inside = pinnedNodes
						.filter((pin) => pin.lo >= node.lo && pin.hi <= node.hi)
						.map(labelOf)
						.filter((pin) => pin !== label);
					const notes = [
						...(inside.length > 0 ? [`contains pinned ${inside.join(", ")}`] : []),
						...(node.partial ? ["continues in the messages below"] : []),
					];
					return `- ${label}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}: ${body}`;
				})
				.join("\n"),
		);
	const files = renderFiles(state);
	if (files) sections.push(files);
	return sections.join("\n\n");
}

export function renderGroup(node: RowNode): string {
	const [a, b] = node.children!;
	return [
		`${labelOf(node)}: ${oneLine(node.summary)}`,
		"",
		"Halves:",
		`- ${labelOf(a)}: ${oneLine(a.summary)}`,
		`- ${labelOf(b)}: ${oneLine(b.summary)}`,
	].join("\n");
}

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

export function renderLeafPage(node: RowNode, pages: string[], page: number): string {
	const more = page < pages.length ? ` Call ${zoomToolName} with page ${page + 1} for more.` : "";
	return `${labelOf(node)} full messages, page ${page} of ${pages.length}.${more}\n\n${pages[page - 1]}`;
}
