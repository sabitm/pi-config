// Replaces Pi compaction with an index of rows. A row is one user-message span (a user prompt and the turns
// until the next prompt). Raw entries stay in the session file, so zoom reads them back by entry ID.
// State lives in CompactionEntry.details.optcompact. Pins are custom entries on the branch.
// A DISABLED file in this directory makes compaction fall back to Pi's default. Tools and commands are
// registered at load time, so run /reload after adding or removing DISABLED.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileOpsOf, paginate, renderGroup, renderLeafPage, renderSummary, searchRows, serializeMessage, zoomToolName } from "./src/render.ts";
import {
	addFileOps,
	commitLeaves,
	commitMerges,
	emptyState,
	findNode,
	groupSpans,
	labelOf,
	lastLeaf,
	normalizeLabel,
	parseState,
	pinTokens,
	planLeaves,
	replacePendingIds,
	resolvePins,
	resolveTarget,
	leavesInRange,
	selectMerges,
	type FileOp,
	type PinEvent,
	type RowNode,
	type SpanItem,
	type State,
} from "./src/rows.ts";
import {
	addUsage,
	batchJobs,
	completeJson,
	leafPrompt,
	mergePrompt,
	parseLeafResponse,
	parseMergeResponse,
	type Complete,
} from "./src/summarize.ts";

const pinType = "optcompact-pin";
const rowBudgetTokens = 8000;
const pinCapTokens = 4000;
const zoomPageChars = 20000;
const toolResultMaxChars = 2000;
const maxMergeRounds = 4;
const maxOutputTokens = 16000;

const extensionDir = join(getAgentDir(), "extensions", "optcompact");
const disabled = () => existsSync(join(extensionDir, "DISABLED"));

type Edits = Map<string, { content: unknown } | null>;
type LooseMessage = Parameters<typeof serializeMessage>[0];

function contextEdits(branch: SessionEntry[]): Edits {
	const edits: Edits = new Map();
	for (const entry of branch) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
	return edits;
}

// Applies context_edit entries the same way Pi builds model context: null omits, a value replaces content.
function entryMessage(entry: SessionEntry, edits: Edits): LooseMessage | undefined {
	let message: LooseMessage;
	if (entry.type === "message") message = entry.message as LooseMessage;
	else if (entry.type === "custom_message") message = { role: "custom", customType: entry.customType, content: entry.content as LooseMessage["content"] };
	else if (entry.type === "branch_summary") message = { role: "branchSummary", summary: entry.summary };
	else return undefined;
	if (message.role === "system") return undefined;
	const edit = edits.get(entry.id);
	if (edit === null) return undefined;
	return edit ? { ...message, content: edit.content as LooseMessage["content"] } : message;
}

const isUserStart = (entry: SessionEntry) =>
	entry.type === "message" && (entry.message as { role?: string }).role === "user";

// The newest optcompact state on the branch. A later default compaction (fallback) has no state and is skipped.
function latestState(branch: SessionEntry[]): State | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "compaction") continue;
		const state = parseState(entry.details);
		if (state) return state;
	}
	return undefined;
}

function pinEvents(branch: SessionEntry[]): PinEvent[] {
	const events: PinEvent[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== pinType) continue;
		const data = entry.data as Partial<PinEvent> | undefined;
		if (typeof data?.target === "string" && typeof data.on === "boolean") events.push(data as PinEvent);
	}
	return events;
}

const branchIndex = (branch: SessionEntry[]) => new Map(branch.map((entry, i) => [entry.id, i]));

export async function compactRows(event: SessionBeforeCompactEvent, ctx: ExtensionContext, options: { rowBudgetTokens?: number } = {}) {
	const model = ctx.model;
	if (!model) throw new Error("no active model");
	const { preparation, signal } = event;
	const branch = event.branchEntries;
	const index = branchIndex(branch);
	const prior = latestState(branch) ?? emptyState();

	// New content starts after the last summarized entry. After a default-compaction fallback this also
	// covers the span that the fallback summarized, so the row index has no gap.
	let start = 0;
	const last = lastLeaf(prior);
	if (last) {
		const position = index.get(last.lastEntryId);
		if (position === undefined) throw new Error(`last row entry ${last.lastEntryId} is not on this branch`);
		start = position + 1;
	}
	// A retain-none compaction uses its own new ID as firstKeptEntryId, which is not on the branch yet.
	const keptIndex = index.get(preparation.firstKeptEntryId);
	const end = keptIndex ?? branch.length;
	if (end < start) throw new Error("kept boundary is before the last summarized row");

	const edits = contextEdits(branch);
	const fileOps: FileOp[] = [];
	// States written before file tracking have no file fields. Rebuild them once from the earlier entries.
	if (prior.readFiles === undefined && prior.modifiedFiles === undefined) {
		for (let i = 0; i < start; i++) {
			const message = entryMessage(branch[i], edits);
			if (message) fileOps.push(...fileOpsOf(message));
		}
	}
	const items: SpanItem[] = [];
	for (let i = start; i < end; i++) {
		const message = entryMessage(branch[i], edits);
		if (!message) continue;
		fileOps.push(...fileOpsOf(message));
		const text = serializeMessage(message, toolResultMaxChars);
		if (text) items.push({ entryId: branch[i].id, userStart: isUserStart(branch[i]), text });
	}
	const cutAtUserStart = keptIndex === undefined || isUserStart(branch[keptIndex]);
	const jobs = planLeaves(prior, groupSpans(items, cutAtUserStart));

	const outputTokens = Math.min(model.maxTokens || maxOutputTokens, maxOutputTokens);
	// About half of the context window for input, at 4 characters for each token, with a floor for small models.
	const maxBatchChars = Math.max(40000, (model.contextWindow - outputTokens) * 2);
	const complete: Complete = async (system, user) => {
		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
			{ maxTokens: outputTokens, signal, cacheRetention: "none", sessionId: uuidv7() },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
		}
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return { text, usage: response.usage, stopReason: response.stopReason };
	};

	let usage: ReturnType<typeof addUsage>;
	let goalNow = prior.goalNow;
	const summaries = new Map<string, string>();
	for (const batch of batchJobs(jobs, maxBatchChars)) {
		const keys = batch.map((job) => job.key);
		const result = await completeJson(
			complete,
			leafPrompt(batch, goalNow, maxBatchChars, event.customInstructions),
			(text) => parseLeafResponse(text, keys),
			signal,
		);
		usage = addUsage(usage, result.usage);
		goalNow = result.value.goalNow;
		for (const [key, summary] of result.value.summaries) summaries.set(key, summary);
	}
	let state = addFileOps(replacePendingIds(commitLeaves(prior, jobs, summaries, goalNow), index), fileOps, ctx.sessionManager.getCwd());

	const events = pinEvents(branch);
	let merges = 0;
	for (let round = 0; round < maxMergeRounds; round++) {
		const mergeJobs = selectMerges(state, options.rowBudgetTokens ?? rowBudgetTokens);
		if (mergeJobs.length === 0) break;
		const keys = mergeJobs.map((job) => job.key);
		const result = await completeJson(complete, mergePrompt(mergeJobs), (text) => parseMergeResponse(text, keys), signal);
		usage = addUsage(usage, result.usage);
		state = commitMerges(state, mergeJobs, result.value);
		merges += mergeJobs.length;
	}

	if (ctx.hasUI) ctx.ui.notify(`optcompact: ${jobs.length} rows summarized, ${merges} merges, ${state.nodes.length} top-level rows.`, "info");
	return {
		summary: renderSummary(state, resolvePins(events, state, index)),
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage,
		details: { optcompact: state },
	};
}

interface Resolved {
	branch: SessionEntry[];
	state: State;
	index: Map<string, number>;
	target: string;
}

// raw undefined, empty, or "current" means the current user-message span.
function resolveInput(ctx: ExtensionContext, raw: string | undefined): Resolved {
	const branch = ctx.sessionManager.getBranch();
	const state = latestState(branch) ?? emptyState();
	const index = branchIndex(branch);
	const input = raw?.trim() ?? "";
	if (input === "" || input === "current") {
		const user = branch.findLast(isUserStart);
		if (!user) throw new Error("This branch has no user message.");
		return { branch, state, index, target: `entry:${user.id}` };
	}
	if (input.startsWith("pending:")) return { branch, state, index, target: `entry:${input.slice("pending:".length)}` };
	const label = normalizeLabel(input);
	if (!label) throw new Error(`Invalid row ID "${input}". Use #N, #A-B, or current.`);
	if (!findNode(state.nodes, label)) throw new Error(`Row ${label} does not exist.`);
	return { branch, state, index, target: label };
}

function pinRow(pi: ExtensionAPI, ctx: ExtensionContext, raw: string | undefined, reason: string): string {
	if (!reason.trim()) throw new Error("A reason is required.");
	const { branch, state, index, target } = resolveInput(ctx, raw);
	const label = resolveTarget(target, state, index);
	const pins = resolvePins(pinEvents(branch), state, index).filter((pin) => pin.label !== label);
	const after = [...pins, { label, reason, node: findNode(state.nodes, label) }];
	const tokens = pinTokens(after);
	if (tokens > pinCapTokens) {
		const list = pins.map((pin) => `${pin.label}: ${pin.reason}`).join("\n");
		throw new Error(`Pinned section would use about ${tokens} tokens, over the ${pinCapTokens}-token cap. Unpin a row first. Current pins:\n${list}`);
	}
	pi.appendEntry(pinType, { target, reason: reason.trim(), on: true } satisfies PinEvent);
	return `Pinned ${label}.`;
}

function unpinRow(pi: ExtensionAPI, ctx: ExtensionContext, raw: string | undefined): string {
	const { branch, state, index, target } = resolveInput(ctx, raw);
	const label = resolveTarget(target, state, index);
	const pins = resolvePins(pinEvents(branch), state, index);
	if (!pins.some((pin) => pin.label === label)) {
		throw new Error(`${label} is not pinned. Pinned: ${pins.map((pin) => pin.label).join(", ") || "(none)"}`);
	}
	pi.appendEntry(pinType, { target, on: false } satisfies PinEvent);
	return `Unpinned ${label}.`;
}

function leafMessages(branch: SessionEntry[], index: Map<string, number>, edits: Edits, leaf: RowNode): string[] {
	const first = index.get(leaf.firstEntryId);
	const last = index.get(leaf.lastEntryId);
	if (first === undefined || last === undefined) throw new Error(`The entries of ${labelOf(leaf)} are not on this branch.`);
	return branch
		.slice(first, last + 1)
		.map((entry) => entryMessage(entry, edits))
		.map((message) => (message ? serializeMessage(message) : ""))
		.filter(Boolean);
}

export function zoom(ctx: ExtensionContext, raw: string, page: number, query?: string): string {
	const branch = ctx.sessionManager.getBranch();
	const state = latestState(branch);
	if (!state) throw new Error("This branch has no optcompact summary yet.");
	const label = normalizeLabel(raw);
	if (!label) throw new Error(`Invalid row ID "${raw}". Use #N or #A-B.`);
	const topRows = state.nodes.map(labelOf).join(", ");
	const index = branchIndex(branch);
	const edits = contextEdits(branch);
	if (query?.trim()) {
		const leaves = leavesInRange(state.nodes, label);
		if (leaves.length === 0) throw new Error(`No row is inside ${label}. Top-level rows: ${topRows}`);
		return searchRows(label, leaves.map((leaf) => ({ label: labelOf(leaf), messages: leafMessages(branch, index, edits, leaf) })), query);
	}
	const node = findNode(state.nodes, label);
	if (!node) throw new Error(`Row ${label} does not exist. Pass query to search all rows in a range. Top-level rows: ${topRows}`);
	if (node.children) return renderGroup(node);
	const pages = paginate(leafMessages(branch, index, edits, node).join("\n\n"), zoomPageChars);
	if (page > pages.length) throw new Error(`${label} has ${pages.length} pages.`);
	return renderLeafPage(node, pages, page);
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function optcompact(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		if (disabled()) return;
		try {
			return { compaction: await compactRows(event, ctx) };
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`optcompact failed: ${message}. Pi uses default compaction.`, "warning");
			}
			return;
		}
	});

	if (disabled()) return;

	pi.registerTool({
		name: zoomToolName,
		label: "Zoom",
		description:
			"Show more detail for a row ID from the compaction summary. With query, returns only the messages that contain the key words; #A-B searches all rows from A to B, even when they are not one group, so use one search over a range for several related facts. Without query, a group ID (#A-B) returns the summaries of its two halves, and a single row ID (#N) returns the full messages of that row, in pages.",
		promptSnippet: "Search or open a compaction summary row (#N or #A-B)",
		promptGuidelines: [
			"Use zoom with a row ID from the compaction summary when you need details that the row summary does not contain.",
			"Pass query with 1 to 4 key words first, for example a name, version, or error. Read full pages only when the matching parts are not enough.",
		],
		parameters: Type.Object({
			id: Type.String({ description: 'Row ID, for example "#12" or "#8-15"' }),
			query: Type.Optional(Type.String({ description: "Key words. Returns only the messages that contain any of them." })),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "Page of a single row without query. Default 1." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(zoom(ctx, params.id, params.page ?? 1, params.query));
		},
	});

	pi.registerTool({
		name: "pin",
		label: "Pin",
		description:
			"Keep a row in the Pinned section of every later compaction summary. Leave id empty to pin the current user request, before it is summarized.",
		promptSnippet: "Pin a compaction row so that its summary always stays visible",
		promptGuidelines: [
			"Use pin when the user states a rule, constraint, or decision that must apply for the rest of the task.",
			"Use unpin when a pinned row's reason no longer applies, for example when the approved work is finished.",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: 'Row ID, for example "#12". Empty means the current user request.' })),
			reason: Type.String({ description: "Why the row must stay visible. State the exact rule or fact." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(pinRow(pi, ctx, params.id, params.reason));
		},
	});

	pi.registerTool({
		name: "unpin",
		label: "Unpin",
		description: "Remove a row from the Pinned section of the compaction summary. Leave id empty for the current user request.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: 'Row ID, for example "#12", or a "pending:" ID from the Pinned section.' })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(unpinRow(pi, ctx, params.id));
		},
	});

	const runCommand = (ctx: ExtensionContext, action: () => string) => {
		try {
			ctx.ui.notify(action(), "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	pi.registerCommand("pin", {
		description: "Pin a compaction row: /pin <#id|current> <reason>",
		handler: async (args, ctx) => {
			const [id = "", ...rest] = args.trim().split(/\s+/);
			runCommand(ctx, () => pinRow(pi, ctx, id, rest.join(" ")));
		},
	});

	pi.registerCommand("unpin", {
		description: "Unpin a compaction row: /unpin <#id|current>",
		handler: async (args, ctx) => {
			runCommand(ctx, () => unpinRow(pi, ctx, args.trim()));
		},
	});
}
