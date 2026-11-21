import { describe, test } from "node:test";
import { addNote, entryText, noteText, rowSummaryGuideline, rowSummaryPrompt, serializeMessage } from "../src/render.ts";
import { expect } from "./expect.ts";

describe("serializeMessage", () => {
	test("leaves out history tool output and keeps other tool output", () => {
		const result = (toolName: string) => ({ role: "toolResult", toolName, content: [{ type: "text", text: "rows" }] });
		expect(serializeMessage(result("history_page"))).toBe("[Tool result history_page]: [history output omitted]");
		expect(serializeMessage(result("history_open"))).toBe("[Tool result history_open]: [history output omitted]");
		expect(serializeMessage(result("bash"))).toBe("[Tool result bash]: rows");
	});
});

describe("entryText", () => {
	test("writes compaction summaries and messages, and nothing for other entries", () => {
		expect(entryText({ type: "compaction", id: "c", parentId: null, summary: "S" })).toBe("[Compaction summary]: S");
		expect(entryText({ type: "message", id: "u", parentId: null, message: { role: "user", content: "hi" } })).toBe("[User]: hi");
		expect(entryText({ type: "model_change", id: "m", parentId: null })).toBe("");
	});
});

describe("addNote", () => {
	test("returns undefined when there is no compaction summary", () => {
		expect(addNote([{ role: "user", content: "hi" }], "/db")).toBeUndefined();
	});

	test("adds the note to the summary without changing the input", () => {
		const messages = [{ role: "compactionSummary", summary: "S" }, { role: "user" }];
		const result = addNote(messages, "/db")!;
		expect((result[0] as { summary: string }).summary).toBe(`S\n\n${noteText("/db")}`);
		expect(result[1]).toBe(messages[1]);
		expect(messages[0].summary).toBe("S");
		expect(noteText("/db")).toContain("sqlite3 /db");
		expect(noteText("/db")).toContain("Read page 1, then page 2 and later");
		expect(noteText("/db")).toContain("Before your first query, read the schema: SELECT name, sql FROM sqlite_master");
	});
});

describe("row summary prompts", () => {
	test("the backfill prompt has the content rules but no tool call", () => {
		const prompt = rowSummaryPrompt("[User]: hi");
		expect(prompt).toContain("Write: the request, what you did");
		expect(prompt).not.toContain("row_summary");
	});

	test("the live guideline still tells the model to call row_summary", () => {
		expect(rowSummaryGuideline).toContain("call row_summary once. Write: the request");
	});
});
