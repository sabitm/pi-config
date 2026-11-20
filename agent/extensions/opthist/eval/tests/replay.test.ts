import { describe, test } from "node:test";
import { expect } from "../../tests/expect.ts";
import { branchBefore, compactionEntry, defaultSlices, loadSession, relink, type Entry } from "../replay.ts";

const msg = (id: string, parentId: string | null, role: string) => ({ type: "message", id, parentId, message: { role, content: id } });

// u1 a1 u2 a2 [c1 keeps from u2] u3 a3 [c2 keeps from a3] u4
function sessionText(): string {
	const lines: unknown[] = [
		{ type: "session", id: "s", cwd: "/proj" },
		msg("u1", null, "user"),
		msg("a1", "u1", "assistant"),
		msg("u2", "a1", "user"),
		msg("a2", "u2", "assistant"),
		{ type: "compaction", id: "c1", parentId: "a2", summary: "S1", firstKeptEntryId: "u2", tokensBefore: 100, timestamp: "t1" },
		msg("u3", "c1", "user"),
		msg("a3", "u3", "assistant"),
		{ type: "compaction", id: "c2", parentId: "a3", summary: "S2", firstKeptEntryId: "a3", tokensBefore: 200, timestamp: "t2" },
		msg("u4", "c2", "user"),
		// An abandoned branch: not on the active path.
		msg("x1", "a1", "user"),
	];
	// The active leaf is the last line, so move u4 to the end.
	const u4 = lines.splice(9, 1)[0];
	lines.push(u4);
	return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("loadSession", () => {
	test("follows the parent chain of the last entry and finds the cut points", () => {
		const session = loadSession(sessionText());
		expect(session.cwd).toBe("/proj");
		expect(session.branch.map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2", "c1", "u3", "a3", "c2", "u4"]);
		expect(session.points.map((p) => [p.number, p.at, p.cut, p.firstKeptEntryId, p.tokensBefore])).toEqual([
			[1, 4, 2, "u2", 100],
			[2, 7, 6, "a3", 200],
		]);
	});

	test("rejects a file without a session header", () => {
		expect(() => loadSession(JSON.stringify(msg("u1", null, "user")))).toThrow("session header");
	});
});

describe("branchBefore", () => {
	test("removes recorded compactions, inserts the method's own, and relinks parents", () => {
		const session = loadSession(sessionText());
		expect(branchBefore(session, new Map(), 1).map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
		const own = compactionEntry("m", session.points[0], { summary: "mine" }, true);
		const branch = branchBefore(session, new Map([[1, own]]), 2);
		expect(branch.map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2", "eval-m-1", "u3", "a3"]);
		expect(branch.map((e) => e.parentId)).toEqual([null, "u1", "a1", "u2", "a2", "eval-m-1", "u3"]);
		expect(branch[4].summary).toBe("mine");
		expect(branch[4].firstKeptEntryId).toBe("u2");
	});

	test("fails when an earlier point has no replayed compaction", () => {
		const session = loadSession(sessionText());
		expect(() => branchBefore(session, new Map(), 2)).toThrow("no replayed compaction for point 1");
	});

	test("relink does not change the input entries", () => {
		const input: Entry[] = [{ type: "message", id: "a", parentId: "zzz" }];
		expect(relink(input)[0].parentId).toBeNull();
		expect(input[0].parentId).toBe("zzz");
	});
});

describe("defaultSlices", () => {
	const projected = (entries: [string, string, string?][]) =>
		entries.map(([type, id, role]) => ({
			sourceEntry: { type, id, parentId: null, summary: type === "compaction" ? "prev" : undefined, message: role ? { role } : undefined } as Entry,
			messages: [{ role: role ?? "compactionSummary" }],
		}));

	test("a cut at a user message summarizes everything before it", () => {
		const slices = defaultSlices(projected([["message", "u1", "user"], ["message", "a1", "assistant"], ["message", "u2", "user"]]), "u2");
		expect(slices.messagesToSummarize.length).toBe(2);
		expect(slices.isSplitTurn).toBe(false);
		expect(slices.previousSummary).toBeUndefined();
	});

	test("a cut inside a span splits off the turn prefix and starts after the previous compaction", () => {
		const slices = defaultSlices(
			projected([
				["compaction", "c1"],
				["message", "u1", "user"],
				["message", "a1", "assistant"],
				["message", "u2", "user"],
				["message", "a2", "assistant"],
				["message", "a3", "assistant"],
			]),
			"a3",
		);
		expect(slices.isSplitTurn).toBe(true);
		expect(slices.messagesToSummarize.length).toBe(2);
		expect(slices.turnPrefixMessages.length).toBe(2);
		expect(slices.previousSummary).toBe("prev");
	});
});
