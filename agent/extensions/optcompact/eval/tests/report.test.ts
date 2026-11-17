import { describe, expect, test } from "bun:test";
import { parseAnswers, parseGrades, renderContext } from "../answer.ts";
import { exactHit, parseQuestions, renderReport, selectQuestions, zoomKind, type AnswerRecord, type Question } from "../report.ts";

const q = (id: string, sourceEntry: string, extra: Partial<Question> = {}): Question => ({
	id,
	type: "rule",
	question: `question ${id}`,
	answer: `answer ${id}`,
	sourceEntry,
	...extra,
});

describe("parseQuestions", () => {
	test("accepts a list or an object with questions", () => {
		expect(parseQuestions([q("a", "e1")]).length).toBe(1);
		expect(parseQuestions({ questions: [q("a", "e1")] }).length).toBe(1);
	});

	test("rejects bad fields and duplicate ids", () => {
		expect(() => parseQuestions([{ ...q("a", "e1"), type: "other" }])).toThrow('"type"');
		expect(() => parseQuestions([{ ...q("a", "e1"), answer: "" }])).toThrow('"answer"');
		expect(() => parseQuestions([q("a", "e1"), q("a", "e2")])).toThrow("duplicate id");
		expect(() => parseQuestions([{ ...q("a", "e1"), mustContain: [""] }])).toThrow('"mustContain"');
	});
});

describe("selectQuestions", () => {
	const positions = new Map(["e0", "e1", "e2", "e3", "e4", "e5"].map((id, i) => [id, i]));
	const point = { number: 1, at: 4, cut: 2 };

	test("asks only facts that exist before the compaction, and marks the ones in the kept messages", () => {
		const asked = selectQuestions([q("old", "e1"), q("kept", "e3"), q("future", "e4")], positions, point);
		expect(asked.map((a) => [a.question.id, a.visibleInKept])).toEqual([
			["old", false],
			["kept", true],
		]);
	});

	test("skips facts that stopped being true before the compaction", () => {
		const asked = selectQuestions([q("stale", "e0", { validUntil: "e3" }), q("live", "e0", { validUntil: "e5" })], positions, point);
		expect(asked.map((a) => a.question.id)).toEqual(["live"]);
	});

	test("fails on an entry that is not on the branch", () => {
		expect(() => selectQuestions([q("x", "nope")], positions, point)).toThrow("sourceEntry nope");
	});
});

describe("answers and grades", () => {
	test("parseAnswers turns missing or empty answers into unknown", () => {
		const answers = parseAnswers('```json\n{"answers": {"a": " yes ", "b": ""}}\n```', ["a", "b", "c"]);
		expect([...answers.values()]).toEqual(["yes", "unknown", "unknown"]);
	});

	test("parseGrades rejects an invalid grade", () => {
		expect(parseGrades('{"grades": {"a": {"grade": "correct", "reason": "ok"}}}', ["a"]).get("a")?.grade).toBe("correct");
		expect(() => parseGrades('{"grades": {"a": {"grade": "great"}}}', ["a"])).toThrow("no valid grade for a");
	});

	test("exactHit needs every mustContain string", () => {
		expect(exactHit(q("a", "e1"), "x")).toBeUndefined();
		expect(exactHit(q("a", "e1", { mustContain: ["abc", "def"] }), "abc and def")).toBe(true);
		expect(exactHit(q("a", "e1", { mustContain: ["abc", "def"] }), "abc only")).toBe(false);
	});

	test("exactHit ignores letter case", () => {
		expect(exactHit(q("a", "e1", { mustContain: ["mainnet"] }), "Mainnet only.")).toBe(true);
	});

	test("renderContext shows the summary and the kept messages", () => {
		const text = renderContext([
			{ role: "system", content: "hidden" },
			{ role: "compactionSummary", summary: "S" },
			{ role: "user", content: "hi" },
		]);
		expect(text).toBe("[Compaction summary]:\nS\n\n[User]: hi");
	});
});

describe("renderReport", () => {
	const record = (method: string, grade: AnswerRecord["grade"], visibleInKept = false): AnswerRecord => ({
		method,
		repeat: 1,
		point: 1,
		questionId: "q",
		type: "rule",
		visibleInKept,
		answer: "",
		grade,
		reason: "",
	});

	test("scores partial as half and keeps kept-message questions apart", () => {
		const text = renderReport(
			[record("m", "correct"), record("m", "partial"), record("m", "wrong"), record("m", "unknown"), record("m", "wrong", true)],
			[{ method: "m", repeat: 1, point: 1, summaryChars: 100, compactionTokens: 10, answerTokens: 5, zoomCalls: 2 }],
		);
		const summaryRow = text.split("\n").find((line) => line.startsWith("m "))!;
		expect(summaryRow.split(/\s{2,}/)).toEqual(["m", "4", "38%", "1", "1", "1", "1", "-", "100", "10", "2"]);
		expect(text).toContain("Control: questions visible in the kept messages:");
		expect(text.split("\n").at(-1)!.split(/\s{2,}/)).toEqual(["m", "1", "0%"]);
		expect(text).not.toContain("Rollup by cut point");
	});

	test("shows rows and groups for methods that have them", () => {
		const base = { repeat: 1, summaryChars: 1, compactionTokens: 1, answerTokens: 1, zoomCalls: 0 };
		const text = renderReport(
			[],
			[
				{ ...base, method: "rows", point: 1, topRows: 7, groups: 0 },
				{ ...base, method: "rows", point: 2, topRows: 9, groups: 3 },
				{ ...base, method: "plain", point: 1 },
			],
		);
		const sections = text.split("\n\n");
		const at = sections.indexOf("Rollup by cut point (top-level rows/groups, first run):");
		expect(sections[at + 1].split("\n").slice(1)).toEqual(["rows    7/0  9/3"]);
	});
});

describe("zoom calls", () => {
	test("zoomKind classifies by outcome and output text", () => {
		expect(zoomKind("x", true, false, true)).toBe("limit");
		expect(zoomKind("Row #9 does not exist.", false, true, false)).toBe("error");
		expect(zoomKind('Search "a" in #1: 2 matching messages.', true, false, false)).toBe("search");
		expect(zoomKind("No message in #1 contains any of: a.", true, false, false)).toBe("search-empty");
		expect(zoomKind("#1-2: s\n\nHalves:\n- #1: a", false, false, false)).toBe("halves");
		expect(zoomKind("#1 full messages, page 1 of 2.", false, false, false)).toBe("page");
	});

	test("renders counts by kind and the average size of answered calls", () => {
		const base = { repeat: 1, point: 1, summaryChars: 1, compactionTokens: 1, answerTokens: 1, zoomCalls: 3 };
		const text = renderReport(
			[],
			[
				{
					...base,
					method: "z",
					zoomLog: [
						{ id: "#1", query: "a", kind: "search", chars: 100 },
						{ id: "#2", page: 1, kind: "page", chars: 300 },
						{ id: "#3", kind: "limit", chars: 50 },
					],
				},
				{ ...base, method: "plain", zoomCalls: 0 },
			],
		);
		const sections = text.split("\n\n");
		const at = sections.indexOf("Zoom calls (all runs):");
		expect(sections[at + 1].split("\n").slice(1).map((line) => line.split(/\s{2,}/))).toEqual([["z", "3", "1", "0", "0", "1", "0", "1", "200"]]);
	});
});
