import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { History } from "../src/db.ts";
import type { Entry } from "../src/render.ts";
import { expect } from "./expect.ts";

const message = (id: string, parentId: string | null, role: string, content: unknown, extra = {}): Entry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-11-20T10:00:00.000Z",
	message: { role, content, ...extra },
});
const text = (value: string) => [{ type: "text", text: value }];

// Active branch: u1 a1 t1 u2 a2 e1 u3. x1 is an abandoned branch after a1. e1 edits a2.
function entries(): Entry[] {
	return [
		message("u1", null, "user", "first request"),
		message("a1", "u1", "assistant", [...text("looking"), { type: "toolCall", name: "history_page", arguments: {} }]),
		message("t1", "a1", "toolResult", text("old rows"), { toolName: "history_page" }),
		message("x1", "a1", "user", "other branch"),
		message("u2", "t1", "user", "second request"),
		message("a2", "u2", "assistant", text("original answer")),
		{ type: "context_edit", id: "e1", parentId: "a2", targetId: "a2", replacement: { content: text("edited answer") } },
		message("u3", "e1", "user", "third request"),
	];
}

function history(leaf = "u3"): History {
	const result = new History(":memory:");
	result.sync(entries(), leaf);
	return result;
}

describe("sync", () => {
	test("skips entries that are already stored", () => {
		const h = history();
		h.sync(entries(), "u3");
		expect(Number(h.db.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n)).toBe(8);
	});

	test("keeps entries after reopening a database file", () => {
		const dir = mkdtempSync(join(tmpdir(), "opthist-"));
		try {
			const path = join(dir, "h.sqlite");
			const first = new History(path);
			first.sync(entries(), "u3");
			first.close();
			const second = new History(path);
			second.sync(entries(), "u3");
			expect(second.rowCount()).toBe(3);
			expect(Number(second.db.prepare("SELECT COUNT(*) AS n FROM entries").get()!.n)).toBe(8);
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rows", () => {
	test("has one row for each user message on the current branch", () => {
		const rows = history().db.prepare("SELECT row, user_entry_id, first_seq, last_seq, request FROM rows").all();
		expect(rows.map((r) => [r.row, r.user_entry_id, r.request])).toEqual([
			[1, "u1", "first request"],
			[2, "u2", "second request"],
			[3, "u3", "third request"],
		]);
		const seqOf = (id: string) => history().db.prepare("SELECT seq FROM entries WHERE id = ?").get(id)!.seq;
		expect(rows.map((r) => [r.first_seq, r.last_seq])).toEqual([
			[seqOf("u1"), seqOf("t1")],
			[seqOf("u2"), seqOf("e1")],
			[seqOf("u3"), seqOf("u3")],
		]);
	});

	test("follows the leaf to another branch", () => {
		const rows = history("x1").db.prepare("SELECT user_entry_id FROM rows").all();
		expect(rows.map((r) => r.user_entry_id)).toEqual(["u1", "x1"]);
	});
});

describe("page", () => {
	test("shows summaries and marks rows without one", () => {
		const h = history();
		h.setSummary("u1", "did the first thing");
		h.setSummary("u1", "did the first thing, version 2");
		const page = h.page();
		expect(page).toContain("Page 1 of 1 (newest and oldest): rows #3 to #1, newest first. No older rows.");
		expect(page).toContain("#1 (2026-11-20 10:00)\nRequest: first request\nSummary: did the first thing, version 2");
		expect(page).toContain("#2 (2026-11-20 10:00)\nRequest: second request\nSummary: (no summary)");
		expect(h.rowOf("u2")).toBe(2);
	});

	test("splits rows into pages of 20, with page 1 the newest, and shows page 1 by default", () => {
		const h = new History(":memory:");
		const list: Entry[] = [];
		for (let i = 1; i <= 45; i++) list.push(message(`u${i}`, i === 1 ? null : `u${i - 1}`, "user", i === 45 ? "x".repeat(400) : `request ${i}`));
		h.sync(list, "u45");
		const first = h.page();
		expect(first).toContain("Page 1 of 3 (newest): rows #45 to #26, newest first. Older rows: page 2.");
		expect(first).toContain(`Request: ${"x".repeat(300)}...`);
		expect(first.indexOf("\n#45 (") < first.indexOf("\n#26 (")).toBe(true);
		expect(first).not.toContain("\n#25 (");
		expect(h.page(2)).toContain("Page 2 of 3: rows #25 to #6, newest first. Older rows: page 3.");
		expect(h.page(3)).toContain("Page 3 of 3 (oldest): rows #5 to #1, newest first. No older rows.");
		expect(() => h.page(4)).toThrow("Pages: 1 (newest) to 3 (oldest).");
	});
});

describe("open", () => {
	test("applies context edits and leaves out history output", () => {
		const h = history();
		expect(h.open(2)).toBe("#2 raw messages, part 1 of 1.\n\n[User]: second request\n\n[Assistant]: edited answer");
		expect(h.open(1)).toContain("[Tool result history_page]: [history output omitted]");
		expect(() => h.open(9)).toThrow("Row #9 does not exist. Rows: #1 to #3.");
	});

	test("splits a large row into parts", () => {
		const h = new History(":memory:");
		h.sync([message("u1", null, "user", "go"), message("a1", "u1", "assistant", text("y".repeat(50000)))], "a1");
		expect(h.open(1)).toContain("part 1 of 3. Call history_open with part 2 for more.");
		expect(() => h.open(1, 4)).toThrow("#1 has 3 parts.");
	});
});

describe("query", () => {
	test("returns rows as JSON lines and refuses writes after readOnly", () => {
		const h = history();
		h.readOnly();
		expect(h.query("SELECT row, request FROM rows WHERE row = 2")).toBe('1 rows.\n{"row":2,"request":"second request"}');
		expect(() => h.query("DELETE FROM entries")).toThrow("readonly");
	});
});

describe("backfill support", () => {
	test("rowsWithoutSummary lists rows newest first and skips the newest row and summarized rows", () => {
		const h = history();
		expect(h.rowsWithoutSummary()).toEqual([
			{ row: 2, userEntryId: "u2" },
			{ row: 1, userEntryId: "u1" },
		]);
		h.setSummary("u2", "done", "backfill");
		expect(h.rowsWithoutSummary()).toEqual([{ row: 1, userEntryId: "u1" }]);
		expect(h.db.prepare("SELECT source FROM row_summaries WHERE user_entry_id = 'u2'").get()!.source).toBe("backfill");
	});

	test("rowText applies context edits, cuts tool results and long rows, and leaves out history output", () => {
		const h = new History(":memory:");
		h.sync(
			[
				message("u1", null, "user", "go"),
				message("t1", "u1", "toolResult", text("z".repeat(50)), { toolName: "bash" }),
				message("t2", "t1", "toolResult", text("rows"), { toolName: "history_open" }),
				message("a1", "t2", "assistant", text("original")),
				{ type: "context_edit", id: "e1", parentId: "a1", targetId: "a1", replacement: { content: text("edited") } },
			],
			"e1",
		);
		expect(h.rowText(1, 10, 1000)).toBe(
			`[User]: go\n\n[Tool result bash]: ${"z".repeat(10)}\n[... 40 more characters]\n\n[Tool result history_open]: [history output omitted]\n\n[Assistant]: edited`,
		);
		expect(h.rowText(1, 10, 20)).toBe("[User]: go\n[...]\nt]: edited");
	});

	test("adds the source column to a database that has none, and keeps old summaries as model", () => {
		const dir = mkdtempSync(join(tmpdir(), "opthist-"));
		try {
			const path = join(dir, "old.sqlite");
			const old = new DatabaseSync(path);
			old.exec("CREATE TABLE row_summaries (user_entry_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL)");
			old.exec("INSERT INTO row_summaries VALUES ('u1', 'old summary', 't')");
			old.close();
			const h = new History(path);
			expect(h.db.prepare("SELECT source FROM row_summaries WHERE user_entry_id = 'u1'").get()!.source).toBe("model");
			h.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
