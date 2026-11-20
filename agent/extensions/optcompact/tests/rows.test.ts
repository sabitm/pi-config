import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderFiles } from "../src/render.ts";
import {
	addFileOps,
	commitLeaves,
	commitMerges,
	emptyState,
	findNode,
	fitsJoined,
	groupChars,
	joinSummaries,
	groupSpans,
	labelOf,
	normalizeFilePath,
	normalizeLabel,
	parseState,
	planLeaves,
	replacePendingIds,
	leavesInRange,
	resolvePins,
	selectMerges,
	type RowNode,
	type SpanItem,
	type State,
} from "../src/rows.ts";

const item = (entryId: string, userStart: boolean): SpanItem => ({ entryId, userStart, text: entryId });

const leaf = (n: number, summary = "x".repeat(400)): RowNode => ({
	lo: n,
	hi: n,
	firstEntryId: `e${n}a`,
	lastEntryId: `e${n}b`,
	summary,
});

const stateOf = (nodes: RowNode[]): State => ({ ...emptyState(), nodes, nextRow: nodes.length + 1 });

const summariesFor = (keys: string[]) => new Map(keys.map((key) => [key, `sum ${key}`]));

describe("labels", () => {
	test("normalizeLabel accepts plain and hash forms", () => {
		expect(normalizeLabel("12")).toBe("#12");
		expect(normalizeLabel(" #8-15 ")).toBe("#8-15");
		expect(normalizeLabel("#3-3")).toBe("#3");
	});

	test("normalizeLabel rejects invalid input", () => {
		expect(normalizeLabel("abc")).toBeUndefined();
		expect(normalizeLabel("#9-2")).toBeUndefined();
		expect(normalizeLabel("")).toBeUndefined();
	});

	test("parseState rejects missing or other versions", () => {
		expect(parseState(undefined)).toBeUndefined();
		expect(parseState({ readFiles: [] })).toBeUndefined();
		expect(parseState({ optcompact: { ...emptyState(), version: 99 } })).toBeUndefined();
		expect(parseState({ optcompact: emptyState() })).toEqual(emptyState());
	});
});

describe("addFileOps", () => {
	test("a used file moves to the most recent position", () => {
		const state = addFileOps(emptyState(), [
			{ path: "a", modified: false },
			{ path: "b", modified: false },
			{ path: "a", modified: false },
			{ path: "c", modified: true },
		], "/proj");
		expect(state.readFiles).toEqual(["b", "a"]);
		expect(state.modifiedFiles).toEqual(["c"]);
	});

	test("a state without file fields still parses and gets the fields", () => {
		const old = parseState({ optcompact: { version: 1, nodes: [], nextRow: 1, goalNow: "" } })!;
		expect(old.readFiles).toBeUndefined();
		expect(addFileOps(old, [], "/proj").readFiles).toEqual([]);
	});

	test("an absolute read and a relative edit of one file give one modified entry", () => {
		const state = addFileOps(emptyState(), [
			{ path: "/proj/src/a.ts", modified: false },
			{ path: "src/a.ts", modified: true },
		], "/proj");
		expect(state.modifiedFiles).toEqual(["src/a.ts"]);
		expect(renderFiles(state)).toBe("<modified-files>\nsrc/a.ts\n</modified-files>");
	});

	test("stored mixed lists are cleaned and keep the most recent position", () => {
		const old: State = { ...emptyState(), readFiles: ["/proj/a", "b", "./a"], modifiedFiles: ["/proj/c", "c"] };
		const state = addFileOps(old, [], "/proj");
		expect(state.readFiles).toEqual(["b", "a"]);
		expect(state.modifiedFiles).toEqual(["c"]);
		expect(addFileOps(state, [], "/proj")).toEqual(state);
	});
});

describe("normalizeFilePath", () => {
	test("a path inside the folder becomes relative", () => {
		expect(normalizeFilePath("/proj/src/a.ts", "/proj")).toBe("src/a.ts");
		expect(normalizeFilePath("./src/../src/a.ts", "/proj")).toBe("src/a.ts");
		expect(normalizeFilePath("@src/a.ts", "/proj")).toBe("src/a.ts");
		expect(normalizeFilePath("file:///proj/src/a.ts", "/proj")).toBe("src/a.ts");
		expect(normalizeFilePath("/proj", "/proj")).toBe(".");
	});

	test("a path outside the folder stays absolute", () => {
		expect(normalizeFilePath("../other/b.ts", "/proj")).toBe("/other/b.ts");
		expect(normalizeFilePath("/projx/b.ts", "/proj")).toBe("/projx/b.ts");
		expect(normalizeFilePath("~/notes.md", "/proj")).toBe(join(homedir(), "notes.md"));
	});

	test("special Unicode spaces become normal spaces", () => {
		expect(normalizeFilePath("my file.ts", "/proj")).toBe("my file.ts");
	});
});

describe("groupSpans", () => {
	test("starts a group at each user message", () => {
		const groups = groupSpans([item("u1", true), item("a1", false), item("u2", true), item("a2", false)], true);
		expect(groups.map((g) => [g.firstEntryId, g.lastEntryId, g.partial, g.continues])).toEqual([
			["u1", "a1", false, false],
			["u2", "a2", false, false],
		]);
	});

	test("marks the first group as a continuation when it does not start with a user message", () => {
		const groups = groupSpans([item("a0", false), item("u1", true)], true);
		expect(groups[0].continues).toBe(true);
		expect(groups[1].continues).toBe(false);
	});

	test("marks the last group partial when the cut is inside a span", () => {
		const groups = groupSpans([item("u1", true), item("a1", false)], false);
		expect(groups[0].partial).toBe(true);
	});
});

describe("leaves", () => {
	test("new groups get sequential row numbers", () => {
		const groups = groupSpans([item("u1", true), item("u2", true)], true);
		const jobs = planLeaves(emptyState(), groups);
		const state = commitLeaves(emptyState(), jobs, summariesFor(["r1", "r2"]), "goal");
		expect(state.nodes.map(labelOf)).toEqual(["#1", "#2"]);
		expect(state.nextRow).toBe(3);
		expect(state.goalNow).toBe("goal");
	});

	test("a continuation extends the partial leaf and keeps its ID", () => {
		const first = commitLeaves(emptyState(), planLeaves(emptyState(), groupSpans([item("u1", true), item("a1", false)], false)), summariesFor(["r1"]), "");
		expect(first.nodes[0].partial).toBe(true);
		const groups = groupSpans([item("a2", false), item("u3", true)], true);
		const jobs = planLeaves(first, groups);
		expect(jobs[0].extend).toBeDefined();
		const second = commitLeaves(first, jobs, summariesFor(["r1", "r2"]), "");
		expect(second.nodes.map(labelOf)).toEqual(["#1", "#2"]);
		expect(second.nodes[0].lastEntryId).toBe("a2");
		expect(second.nodes[0].partial).toBeUndefined();
		expect(second.nodes[1].firstEntryId).toBe("u3");
	});

	test("a partial leaf that is not continued loses the partial flag", () => {
		const first = commitLeaves(emptyState(), planLeaves(emptyState(), groupSpans([item("u1", true)], false)), summariesFor(["r1"]), "");
		const second = commitLeaves(first, planLeaves(first, groupSpans([item("u2", true)], true)), summariesFor(["r1"]), "");
		expect(second.nodes[0].partial).toBeUndefined();
	});

	test("a missing summary is rejected", () => {
		const jobs = planLeaves(emptyState(), groupSpans([item("u1", true)], true));
		expect(() => commitLeaves(emptyState(), jobs, new Map(), "")).toThrow("missing summary for r1");
	});
});

describe("merges", () => {
	test("no merge when under budget", () => {
		expect(selectMerges(stateOf([leaf(1), leaf(2)]), 10000)).toEqual([]);
	});

	test("merges the most due pair first and skips partial nodes", () => {
		const state = stateOf([leaf(1), leaf(2), leaf(3), leaf(4), { ...leaf(5), partial: true }]);
		const jobs = selectMerges(state, 300);
		expect(jobs.map((job) => [labelOf(job.a), labelOf(job.b)])).toEqual([["#1", "#2"], ["#3", "#4"]]);
	});

	const group = (lo: number): RowNode => ({ ...leaf(lo), hi: lo + 1, lastEntryId: `e${lo + 1}b`, children: [leaf(lo), leaf(lo + 1)] });
	const pairs = (jobs: ReturnType<typeof selectMerges>) => jobs.map((job) => [labelOf(job.a), labelOf(job.b)]);

	test("a recent pair of single rows merges before an old pair of groups that is less due", () => {
		const state = stateOf([group(1), group(3), ...[5, 6, 7, 8, 9, 10, 11, 12].map((n) => leaf(n))]);
		expect(pairs(selectMerges(state, 1000))).toEqual([["#5", "#6"]]);
	});

	test("an old pair of groups merges once it is old relative to its size", () => {
		const state = stateOf([group(1), group(3), leaf(5), leaf(6), leaf(7)]);
		expect(pairs(selectMerges(state, 500))).toEqual([["#1-2", "#3-4"]]);
	});

	test("an equally due pair goes to the oldest", () => {
		const state = stateOf([group(1), leaf(3), leaf(4), leaf(5)]);
		expect(labelOf(selectMerges(state, 400)[0].a)).toBe("#1-2");
	});

	test("the estimate counts a merged line at the group size, or joined when the pair fits", () => {
		// 400-character rows: a pair does not fit in 500, so it saves down to 500 characters.
		expect(pairs(selectMerges(stateOf([leaf(1), leaf(2), leaf(3)]), 230))).toEqual([["#1", "#2"]]);
		// 100-character rows join to 201 characters and save only the line prefix, so more pairs are needed.
		const small = [1, 2, 3, 4, 5, 6].map((n) => leaf(n, "x".repeat(100)));
		expect(pairs(selectMerges(stateOf(small), 159))).toEqual([["#1", "#2"], ["#3", "#4"], ["#5", "#6"]]);
	});

	test("groupChars is the budget over 40 lines, from 500 to 2000 characters", () => {
		expect(groupChars(2000)).toBe(500);
		expect(groupChars(8000)).toBe(800);
		expect(groupChars(16000)).toBe(1600);
		expect(groupChars(40000)).toBe(2000);
	});

	test("a pair that fits is joined unchanged", () => {
		const job = { key: "m1", a: leaf(1, "alpha"), b: leaf(2, "beta") };
		expect(joinSummaries(job)).toBe("alpha\nbeta");
		expect(fitsJoined(job, 10)).toBe(true);
		expect(fitsJoined(job, 9)).toBe(false);
	});

	test("commitMerges replaces the pair with a parent node", () => {
		const state = stateOf([leaf(1), leaf(2), leaf(3)]);
		const jobs = selectMerges(state, 250);
		const next = commitMerges(state, jobs, summariesFor(jobs.map((job) => job.key)));
		expect(next.nodes.map(labelOf)).toEqual(["#1-2", "#3"]);
		expect(next.nodes[0].firstEntryId).toBe("e1a");
		expect(next.nodes[0].lastEntryId).toBe("e2b");
		expect(findNode(next.nodes, "#2")?.summary).toBe("x".repeat(400));
	});
});

describe("pins", () => {
	const state = stateOf([leaf(1), leaf(2)]);
	const index = new Map(["e1a", "e1m", "e1b", "e2a", "e2b", "e3a"].map((id, i) => [id, i]));

	test("an entry pin resolves to the leaf that contains it, else stays pending", () => {
		const pins = resolvePins(
			[
				{ target: "entry:e1m", reason: "r1", on: true },
				{ target: "entry:e3a", reason: "r3", on: true },
			],
			state,
			index,
		);
		expect(pins.map((pin) => [pin.label, Boolean(pin.node)])).toEqual([
			["#1", true],
			["pending:e3a", false],
		]);
	});

	test("unpin by label removes a pin made by entry", () => {
		const pins = resolvePins(
			[
				{ target: "entry:e2a", reason: "r", on: true },
				{ target: "#2", on: false },
			],
			state,
			index,
		);
		expect(pins).toEqual([]);
	});

	test("replacePendingIds rewrites IDs that now have a row and keeps the others", () => {
		const input: State = {
			...state,
			goalNow: "Rule pinned as pending:e1m. Next pending:e3a.",
			nodes: [{ ...leaf(1), summary: "got pending:e1m" }, { ...leaf(2), summary: "no ids here" }],
		};
		const next = replacePendingIds(input, index);
		expect(next.goalNow).toBe("Rule pinned as #1. Next pending:e3a.");
		expect(next.nodes[0].summary).toBe("got #1");
		expect(next.nodes[1].summary).toBe("no ids here");
		expect(input.goalNow).toContain("pending:e1m");
	});

	test("re-pin replaces the reason", () => {
		const pins = resolvePins(
			[
				{ target: "#1", reason: "old", on: true },
				{ target: "#1", reason: "new", on: true },
			],
			state,
			index,
		);
		expect(pins.map((pin) => pin.reason)).toEqual(["new"]);
	});
});

describe("leavesInRange", () => {
	test("returns single rows inside the range, also inside groups, and nothing for a bad label", () => {
		const group: RowNode = { ...leaf(1), hi: 2, lastEntryId: "e2b", summary: "g", children: [leaf(1), leaf(2)] };
		const nodes = [group, leaf(3), leaf(4), leaf(5)];
		expect(leavesInRange(nodes, "#2-4").map(labelOf)).toEqual(["#2", "#3", "#4"]);
		expect(leavesInRange(nodes, "#1-2").map(labelOf)).toEqual(["#1", "#2"]);
		expect(leavesInRange(nodes, "#4").map(labelOf)).toEqual(["#4"]);
		expect(leavesInRange(nodes, "#9-12")).toEqual([]);
		expect(leavesInRange(nodes, "bad")).toEqual([]);
	});
});
