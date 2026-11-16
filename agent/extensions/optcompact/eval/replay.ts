// Session replay: branch loading, recorded cut points, and synthetic compaction entries. No Pi imports.
import type { CutPoint } from "./report.ts";

export interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export interface Session {
	cwd: string;
	// Active branch from the root to the last entry in the file, recorded compactions included.
	branch: Entry[];
	positions: Map<string, number>;
	points: (CutPoint & { firstKeptEntryId: string; tokensBefore: number; timestamp?: string })[];
}

// The active branch is the parent chain of the last entry in the file, as Pi resumes it.
export function loadSession(jsonl: string): Session {
	const lines = jsonl.split("\n").filter((line) => line.trim());
	const header = JSON.parse(lines[0]) as { type?: string; cwd?: string };
	if (header.type !== "session" || typeof header.cwd !== "string") throw new Error("first line is not a session header");
	const entries = lines.slice(1).map((line) => JSON.parse(line) as Entry);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: Entry[] = [];
	for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.unshift(entry);
	const positions = new Map(branch.map((entry, i) => [entry.id, i]));
	const points: Session["points"] = [];
	branch.forEach((entry, at) => {
		if (entry.type !== "compaction") return;
		const firstKeptEntryId = entry.firstKeptEntryId as string;
		const cut = positions.get(firstKeptEntryId);
		if (cut === undefined) throw new Error(`compaction ${entry.id} keeps from ${firstKeptEntryId}, which is not on the branch`);
		points.push({ number: points.length + 1, at, cut, firstKeptEntryId, tokensBefore: entry.tokensBefore as number, timestamp: entry.timestamp });
	});
	return { cwd: header.cwd, branch, positions, points };
}

// Pi builds context by following parentId from the leaf, so every replayed branch must be one linked chain.
export function relink(entries: Entry[]): Entry[] {
	return entries.map((entry, i) => ({ ...entry, parentId: i === 0 ? null : entries[i - 1].id }));
}

// Raw entries before cut point `number`, with the recorded compactions replaced by this method's own.
export function branchBefore(session: Session, synthetic: Map<number, Entry>, number: number): Entry[] {
	const point = session.points[number - 1];
	const result: Entry[] = [];
	const pointAt = new Map(session.points.map((p) => [p.at, p.number]));
	for (let i = 0; i < point.at; i++) {
		const entry = session.branch[i];
		if (entry.type !== "compaction") {
			result.push(entry);
			continue;
		}
		const own = synthetic.get(pointAt.get(i)!);
		if (!own) throw new Error(`no replayed compaction for point ${pointAt.get(i)}`);
		result.push(own);
	}
	return relink(result);
}

export function compactionEntry(
	method: string,
	point: Session["points"][number],
	result: { summary: string; details?: unknown },
	fromHook: boolean,
): Entry {
	return {
		type: "compaction",
		id: `eval-${method}-${point.number}`,
		parentId: null,
		timestamp: point.timestamp,
		summary: result.summary,
		firstKeptEntryId: point.firstKeptEntryId,
		tokensBefore: point.tokensBefore,
		details: result.details,
		fromHook,
	};
}

interface Projected {
	sourceEntry: Entry;
	messages: { role: string }[];
}

const isUserStart = (entry: Entry) => entry.type === "message" && (entry.message as { role?: string })?.role === "user";

// Mirrors Pi's prepareCompaction at a fixed cut: Pi does not export it, and the cut must match the recording.
export function defaultSlices(projected: Projected[], cutId: string) {
	const previous = projected.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const start = previous + 1;
	const cut = projected.findIndex((entry) => entry.sourceEntry.id === cutId);
	if (cut < start) throw new Error(`cut entry ${cutId} is not after the previous compaction`);
	let turnStart = -1;
	if (!isUserStart(projected[cut].sourceEntry)) {
		for (let i = cut - 1; i >= start; i--) {
			if (isUserStart(projected[i].sourceEntry)) {
				turnStart = i;
				break;
			}
		}
	}
	const messages = (from: number, to: number) =>
		projected
			.slice(from, to)
			.flatMap((entry) => (entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((m) => m.role !== "system")));
	const previousEntry = previous >= 0 ? projected[previous].sourceEntry : undefined;
	return {
		messagesToSummarize: messages(start, turnStart >= 0 ? turnStart : cut),
		turnPrefixMessages: turnStart >= 0 ? messages(turnStart, cut) : [],
		isSplitTurn: turnStart >= 0,
		previousSummary: previousEntry?.summary as string | undefined,
		previousDetails: previousEntry?.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined,
	};
}
