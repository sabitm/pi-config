// Row state, span grouping, pins, and rollup selection. No Pi imports, so bun tests run without Pi.
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_VERSION = 1;

export interface RowNode {
	lo: number;
	hi: number;
	firstEntryId: string;
	lastEntryId: string;
	summary: string;
	// Leaf only: the user-message span continued past the compaction cut. The next compaction extends it.
	partial?: boolean;
	children?: [RowNode, RowNode];
}

export interface State {
	version: number;
	// Top-level nodes in chronological order. Their leaf ranges are contiguous and ascending.
	nodes: RowNode[];
	nextRow: number;
	goalNow: string;
	// Ordered by last use, oldest first. Optional so that states written before file tracking still parse.
	readFiles?: string[];
	modifiedFiles?: string[];
}

export interface FileOp {
	path: string;
	modified: boolean;
}

const unicodeSpaces = /[  -   　]/g;

// Mirrors how Pi's read, write, and edit tools resolve a path: they resolve relative paths against the
// session cwd, not the bash cwd. If Pi changes that rule, these paths point at the wrong files.
export function normalizeFilePath(path: string, cwd: string): string {
	let value = path.replace(unicodeSpaces, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	else if (value.startsWith("file://")) value = fileURLToPath(value);
	const absolute = resolve(cwd, value);
	const inside = relative(resolve(cwd), absolute);
	if (inside === "") return ".";
	return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? absolute : inside;
}

// Lists keep the order of last use. A path moves to the end each time it is used again.
const touch = (list: string[], path: string) => {
	const i = list.indexOf(path);
	if (i >= 0) list.splice(i, 1);
	list.push(path);
};

// Stored lists are normalized again too, so lists written before normalization are cleaned. The result is
// the same when this runs again.
export function addFileOps(state: State, ops: FileOp[], cwd: string): State {
	const next: State = structuredClone(state);
	const read: string[] = [];
	const modified: string[] = [];
	for (const path of next.readFiles ?? []) touch(read, normalizeFilePath(path, cwd));
	for (const path of next.modifiedFiles ?? []) touch(modified, normalizeFilePath(path, cwd));
	for (const op of ops) touch(op.modified ? modified : read, normalizeFilePath(op.path, cwd));
	next.readFiles = read;
	next.modifiedFiles = modified;
	return next;
}

export const emptyState = (): State => ({ version: STATE_VERSION, nodes: [], nextRow: 1, goalNow: "" });

export const labelOf = (node: { lo: number; hi: number }) => (node.lo === node.hi ? `#${node.lo}` : `#${node.lo}-${node.hi}`);

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function parseState(details: unknown): State | undefined {
	const state = (details as { optcompact?: State } | undefined)?.optcompact;
	if (!state || state.version !== STATE_VERSION || !Array.isArray(state.nodes)) return undefined;
	return state;
}

export function* walk(nodes: RowNode[]): Generator<RowNode> {
	for (const node of nodes) {
		yield node;
		if (node.children) yield* walk(node.children);
	}
}

export function findNode(nodes: RowNode[], label: string): RowNode | undefined {
	for (const node of walk(nodes)) if (labelOf(node) === label) return node;
	return undefined;
}

export const lastLeaf = (state: State): RowNode | undefined => {
	let node = state.nodes.at(-1);
	while (node?.children) node = node.children[1];
	return node;
};

const depth = (node: RowNode): number => (node.children ? 1 + Math.max(depth(node.children[0]), depth(node.children[1])) : 0);

// Accepts "12", "#12", "8-15", "#8-15". Returns undefined for anything else.
export function normalizeLabel(raw: string): string | undefined {
	const match = raw.trim().match(/^#?(\d+)(?:-(\d+))?$/);
	if (!match) return undefined;
	const lo = Number(match[1]);
	const hi = match[2] === undefined ? lo : Number(match[2]);
	return hi < lo ? undefined : labelOf({ lo, hi });
}

export interface SpanItem {
	entryId: string;
	userStart: boolean;
	text: string;
}

export interface Group {
	firstEntryId: string;
	lastEntryId: string;
	texts: string[];
	// The first group does not start with a user message, so it continues the span before it.
	continues: boolean;
	partial: boolean;
}

// cutAtUserStart: the first kept entry starts a new span, so the last group is complete.
export function groupSpans(items: SpanItem[], cutAtUserStart: boolean): Group[] {
	const groups: Group[] = [];
	for (const item of items) {
		const current = groups.at(-1);
		if (current && !item.userStart) {
			current.lastEntryId = item.entryId;
			current.texts.push(item.text);
			continue;
		}
		groups.push({
			firstEntryId: item.entryId,
			lastEntryId: item.entryId,
			texts: [item.text],
			continues: !current && !item.userStart,
			partial: false,
		});
	}
	const last = groups.at(-1);
	if (last && !cutAtUserStart) last.partial = true;
	return groups;
}

export interface LeafJob {
	key: string;
	group: Group;
	// Set when the job extends the partial leaf of the previous compaction.
	extend?: RowNode;
}

export function planLeaves(state: State, groups: Group[]): LeafJob[] {
	const top = state.nodes.at(-1);
	const partial = top && !top.children && top.partial ? top : undefined;
	return groups.map((group, i) => ({
		key: `r${i + 1}`,
		group,
		extend: i === 0 && group.continues ? partial : undefined,
	}));
}

export function commitLeaves(state: State, jobs: LeafJob[], summaries: Map<string, string>, goalNow: string): State {
	const next: State = structuredClone(state);
	next.goalNow = goalNow;
	const top = next.nodes.at(-1);
	if (jobs.length > 0 && top?.partial && !jobs[0].extend) delete top.partial;
	for (const job of jobs) {
		const summary = summaries.get(job.key);
		if (summary === undefined) throw new Error(`missing summary for ${job.key}`);
		if (job.extend) {
			const leaf = next.nodes.at(-1)!;
			leaf.summary = summary;
			leaf.lastEntryId = job.group.lastEntryId;
			if (job.group.partial) leaf.partial = true;
			else delete leaf.partial;
			continue;
		}
		const leaf: RowNode = {
			lo: next.nextRow,
			hi: next.nextRow,
			firstEntryId: job.group.firstEntryId,
			lastEntryId: job.group.lastEntryId,
			summary,
		};
		if (job.group.partial) leaf.partial = true;
		next.nodes.push(leaf);
		next.nextRow++;
	}
	return next;
}

export interface PinEvent {
	// "#12", "#8-15", or "entry:<entryId>" for a span that has no row yet.
	target: string;
	reason?: string;
	on: boolean;
}

export interface Pin {
	label: string;
	reason: string;
	// Undefined while the pinned span is not yet summarized into a row.
	node?: RowNode;
}

export const pendingLabel = (entryId: string) => `pending:${entryId}`;

// branchIndex maps entry IDs on the current branch to their position.
export function resolveTarget(target: string, state: State, branchIndex: Map<string, number>): string {
	if (!target.startsWith("entry:")) return target;
	const entryId = target.slice("entry:".length);
	const position = branchIndex.get(entryId);
	if (position !== undefined) {
		for (const node of walk(state.nodes)) {
			if (node.children) continue;
			const first = branchIndex.get(node.firstEntryId);
			const last = branchIndex.get(node.lastEntryId);
			if (first !== undefined && last !== undefined && first <= position && position <= last) return labelOf(node);
		}
	}
	return pendingLabel(entryId);
}

// The model sometimes copies pending IDs from tool output. Point them at the row that now holds the entry.
export function replacePendingIds(state: State, branchIndex: Map<string, number>): State {
	const replace = (text: string) =>
		text.replace(/pending:([0-9A-Za-z-]+)/g, (match, entryId: string) => {
			const label = resolveTarget(`entry:${entryId}`, state, branchIndex);
			return label.startsWith("#") ? label : match;
		});
	const next: State = structuredClone(state);
	next.goalNow = replace(next.goalNow);
	for (const node of walk(next.nodes)) node.summary = replace(node.summary);
	return next;
}

export function resolvePins(events: PinEvent[], state: State, branchIndex: Map<string, number>): Pin[] {
	const pins = new Map<string, Pin>();
	for (const event of events) {
		const label = resolveTarget(event.target, state, branchIndex);
		if (!event.on) {
			pins.delete(label);
			continue;
		}
		// Delete first so a re-pin moves to the end with its new reason.
		pins.delete(label);
		pins.set(label, { label, reason: event.reason ?? "", node: findNode(state.nodes, label) });
	}
	return [...pins.values()];
}

// Pending pins have no summary yet. Reserve room for the row summary that the next compaction writes.
const pendingSummaryTokens = 100;

export function pinTokens(pins: Pin[]): number {
	let total = 0;
	for (const pin of pins) {
		total += estimateTokens(`${pin.label}: ${pin.node?.summary ?? ""} ${pin.reason}`);
		if (!pin.node) total += pendingSummaryTokens;
	}
	return total;
}

export const rowTokens = (nodes: RowNode[]) =>
	nodes.reduce((sum, node) => sum + estimateTokens(`- ${labelOf(node)}: ${node.summary}\n`), 0);

export interface MergeJob {
	key: string;
	a: RowNode;
	b: RowNode;
}

// A merged summary is expected to be about 60% of its two children combined.
export const mergeShrink = 0.6;

// One round: pick disjoint adjacent pairs, shallowest first and then oldest, until the estimate fits the budget.
// Pinned rows merge too. The Pinned section shows the pinned node itself, which a merge does not rewrite.
export function selectMerges(state: State, budgetTokens: number): MergeJob[] {
	let estimate = rowTokens(state.nodes);
	const used = new Set<number>();
	const jobs: MergeJob[] = [];
	const mergeable = (node: RowNode) => !node.partial;
	while (estimate > budgetTokens) {
		let best = -1;
		let bestDepth = Infinity;
		for (let i = 0; i + 1 < state.nodes.length; i++) {
			const a = state.nodes[i];
			const b = state.nodes[i + 1];
			if (used.has(i) || used.has(i + 1) || !mergeable(a) || !mergeable(b)) continue;
			const pairDepth = Math.max(depth(a), depth(b));
			if (pairDepth < bestDepth) {
				best = i;
				bestDepth = pairDepth;
			}
		}
		if (best < 0) break;
		const a = state.nodes[best];
		const b = state.nodes[best + 1];
		used.add(best);
		used.add(best + 1);
		jobs.push({ key: `m${jobs.length + 1}`, a, b });
		estimate -= Math.floor((1 - mergeShrink) * rowTokens([a, b]));
	}
	return jobs;
}

export function commitMerges(state: State, jobs: MergeJob[], summaries: Map<string, string>): State {
	const next: State = structuredClone(state);
	for (const job of jobs) {
		const summary = summaries.get(job.key);
		if (summary === undefined) throw new Error(`missing summary for ${job.key}`);
		const i = next.nodes.findIndex((node) => labelOf(node) === labelOf(job.a));
		const b = next.nodes[i + 1];
		if (i < 0 || !b || labelOf(b) !== labelOf(job.b)) throw new Error(`merge pair ${labelOf(job.a)} ${labelOf(job.b)} is not adjacent`);
		const a = next.nodes[i];
		next.nodes.splice(i, 2, {
			lo: a.lo,
			hi: b.hi,
			firstEntryId: a.firstEntryId,
			lastEntryId: b.lastEntryId,
			summary,
			children: [a, b],
		});
	}
	return next;
}
