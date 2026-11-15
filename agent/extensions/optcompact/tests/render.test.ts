import { describe, expect, test } from "bun:test";
import { fileOpsOf, paginate, renderFiles, renderGroup, renderSummary, serializeMessage } from "../src/render.ts";
import { addFileOps, emptyState, type RowNode } from "../src/rows.ts";
import { batchJobs, clipMiddle, parseLeafResponse, parseMergeResponse } from "../src/summarize.ts";

const leaf = (n: number, summary: string): RowNode => ({ lo: n, hi: n, firstEntryId: `a${n}`, lastEntryId: `b${n}`, summary });

describe("serializeMessage", () => {
	test("renders assistant text and tool calls, and leaves out thinking", () => {
		const text = serializeMessage({
			role: "assistant",
			content: [
				{ type: "thinking", text: "secret" },
				{ type: "text", text: "hi" },
				{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			],
		});
		expect(text).toBe('[Assistant]: hi\n[Assistant tool calls]: read({"path":"a.ts"})');
	});

	test("clips tool results only when a limit is given", () => {
		const message = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(50) }] };
		expect(serializeMessage(message, 10)).toContain("[... 40 more characters]");
		expect(serializeMessage(message)).not.toContain("more characters");
	});

	test("leaves out zoom output when summarizing, keeps it in zoom", () => {
		const message = { role: "toolResult", toolName: "zoom", content: [{ type: "text", text: "old rows" }] };
		expect(serializeMessage(message, 2000)).toBe("[Tool result]: [zoom output omitted]");
		expect(serializeMessage(message)).toContain("old rows");
	});
});

describe("renderSummary", () => {
	test("renders sections, pins, and partial rows", () => {
		const state = { ...emptyState(), goalNow: "Build X", nodes: [leaf(1, "did a\nthen b"), { ...leaf(2, "doing c"), partial: true }] };
		const text = renderSummary(state, [
			{ label: "#1", reason: "user rule", node: state.nodes[0] },
			{ label: "pending:e9", reason: "new rule" },
		]);
		expect(text).toContain("## Goal and current state\n\nBuild X");
		expect(text).toContain("- #1: did a then b\n  Pinned because: user rule");
		expect(text).toContain("- pending:e9 (not yet summarized, in the messages below)");
		expect(text).toContain("- #2 (continues in the messages below): doing c");
	});

	test("a pinned top-level row shows the short form in Rows", () => {
		const state = { ...emptyState(), nodes: [leaf(1, "full text"), leaf(2, "other")] };
		const text = renderSummary(state, [{ label: "#1", reason: "rule", node: state.nodes[0] }]);
		expect(text).toContain("- #1: (pinned, see Pinned above)");
		expect(text).toContain("- #2: other");
		expect(text.match(/full text/g)?.length).toBe(1);
	});

	test("ends with sorted file lists, read-only files exclude modified files", () => {
		const state = addFileOps(emptyState(), [
			{ path: "b.ts", modified: false },
			{ path: "a.ts", modified: false },
			{ path: "b.ts", modified: true },
		], "/proj");
		const text = renderSummary(state, []);
		expect(text.endsWith("<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>")).toBe(true);
	});

	test("no file blocks when no files were used", () => {
		expect(renderSummary(emptyState(), [])).not.toContain("<read-files>");
		expect(renderFiles(emptyState())).toBe("");
	});

	test("renderGroup lists both halves", () => {
		const group: RowNode = { ...leaf(1, "both"), hi: 2, children: [leaf(1, "one"), leaf(2, "two")] };
		expect(renderGroup(group)).toBe("#1-2: both\n\nHalves:\n- #1: one\n- #2: two");
	});
});

describe("file operations", () => {
	test("fileOpsOf reads read, write, and edit tool calls and ignores others", () => {
		const ops = fileOpsOf({
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", name: "edit", arguments: { path: "b.ts" } },
				{ type: "toolCall", name: "write", arguments: { path: "c.ts" } },
				{ type: "toolCall", name: "bash", arguments: { command: "cat d.ts" } },
				{ type: "toolCall", name: "read", arguments: {} },
			],
		});
		expect(ops).toEqual([
			{ path: "a.ts", modified: false },
			{ path: "b.ts", modified: true },
			{ path: "c.ts", modified: true },
		]);
	});

	test("fileOpsOf reads codemode nested calls on tool results", () => {
		const ops = fileOpsOf({ role: "toolResult", toolName: "code", nestedCalls: { calls: [{ name: "edit", arguments: { path: "x.ts" } }] } });
		expect(ops).toEqual([{ path: "x.ts", modified: true }]);
		expect(fileOpsOf({ role: "user", content: "read a.ts" })).toEqual([]);
	});

	test("the read list keeps the 100 most recently read files and notes the rest", () => {
		const ops = Array.from({ length: 105 }, (_, i) => ({ path: `f${String(i).padStart(3, "0")}.ts`, modified: false }));
		// f000 is read again last, so it is one of the most recent files.
		ops.push({ path: "f000.ts", modified: false });
		const text = renderFiles(addFileOps(emptyState(), ops, "/proj"));
		expect(text).toContain("f000.ts");
		expect(text).not.toContain("f001.ts");
		expect(text).not.toContain("f005.ts");
		expect(text).toContain("f006.ts");
		expect(text).toContain("5 older read-only files not listed.");
	});
});

describe("paginate", () => {
	test("splits text into pages that join back to the original", () => {
		const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const pages = paginate(text, 60);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.join("")).toBe(text);
		expect(pages.every((page) => page.length <= 60)).toBe(true);
	});
});

describe("summarize helpers", () => {
	test("parseLeafResponse reads rows and goalNow from fenced JSON", () => {
		const result = parseLeafResponse('```json\n{"rows": {"r1": " a "}, "goalNow": "g"}\n```', ["r1"]);
		expect(result.summaries.get("r1")).toBe("a");
		expect(result.goalNow).toBe("g");
	});

	test("parseLeafResponse rejects a missing key", () => {
		expect(() => parseLeafResponse('{"rows": {}, "goalNow": ""}', ["r1"])).toThrow("no summary for r1");
	});

	test("parseMergeResponse rejects a response without JSON", () => {
		expect(() => parseMergeResponse("sorry", ["m1"])).toThrow("no JSON object");
	});

	test("clipMiddle keeps head and tail", () => {
		const text = clipMiddle(`${"a".repeat(10)}${"b".repeat(10)}`, 10);
		expect(text.startsWith("aaaaa")).toBe(true);
		expect(text.endsWith("bbbbb")).toBe(true);
	});

	test("batchJobs splits by size and keeps order", () => {
		const job = (key: string, size: number) => ({
			key,
			group: { firstEntryId: key, lastEntryId: key, texts: ["x".repeat(size)], continues: false, partial: false },
		});
		const batches = batchJobs([job("r1", 60), job("r2", 60), job("r3", 30)], 100);
		expect(batches.map((batch) => batch.map((j) => j.key))).toEqual([["r1"], ["r2", "r3"]]);
	});
});
