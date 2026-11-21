import { describe, test } from "node:test";
import { expect } from "../../tests/expect.ts";
import { parseAnswers, parseGrades, renderContext } from "../answer.ts";
import { exactHit, parseQuestions, renderReport, sampleQuestions, selectQuestions, type AnswerRecord, type Question } from "../report.ts";

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
			[{ method: "m", repeat: 1, point: 1, summaryChars: 100, compactionTokens: 10, answerTokens: 5, answerCachedTokens: 3, toolCalls: 2 }],
		);
		const summaryRow = text.split("\n").find((line) => line.startsWith("m "))!;
		expect(summaryRow.split(/\s{2,}/)).toEqual(["m", "4", "38%", "1", "1", "1", "1", "-", "100", "10", "2", "3"]);
		expect(text).toContain("Control: questions visible in the kept messages:");
		expect(text.split("\n").at(-1)!.split(/\s{2,}/)).toEqual(["m", "1", "0%"]);
		expect(text).not.toContain("Rollup by cut point");
	});
});

describe("score by source age", () => {
	test("splits questions into old, middle, and recent thirds", () => {
		const record = (grade: AnswerRecord["grade"], sourceAge: number, visibleInKept = false): AnswerRecord => ({
			method: "m",
			repeat: 1,
			point: 1,
			questionId: "q",
			type: "rule",
			visibleInKept,
			answer: "",
			grade,
			reason: "",
			sourceAge,
		});
		const text = renderReport(
			[record("correct", 0.1), record("wrong", 0.2), record("correct", 0.5), record("partial", 0.9), record("wrong", 0.95, true)],
			[{ method: "m", repeat: 1, point: 1, summaryChars: 1, compactionTokens: 1, answerTokens: 1, toolCalls: 0 }],
		);
		const sections = text.split("\n\n");
		const at = sections.findIndex((section) => section.startsWith("Score by source age"));
		expect(sections[at + 1].split("\n").slice(1).map((line) => line.split(/\s{2,}/))).toEqual([["m", "50% (2)", "100% (1)", "50% (1)"]]);
	});
});

describe("tool calls", () => {
	test("renders counts by tool, errors, limit, and the average size of answered calls", () => {
		const base = { repeat: 1, point: 1, summaryChars: 1, compactionTokens: 1, answerTokens: 1, toolCalls: 4 };
		const text = renderReport(
			[],
			[
				{
					...base,
					method: "h",
					toolLog: [
						{ tool: "history_page", args: {}, kind: "ok", chars: 100 },
						{ tool: "history_open", args: { row: 2 }, kind: "ok", chars: 300 },
						{ tool: "sql", args: { query: "x" }, kind: "error", chars: 20 },
						{ tool: "sql", args: { query: "y" }, kind: "limit", chars: 50 },
					],
				},
				{ ...base, method: "plain", toolCalls: 0 },
			],
		);
		const sections = text.split("\n\n");
		const at = sections.findIndex((section) => section.startsWith("Tool calls (all runs"));
		const [header, ...rows] = sections[at + 1].split("\n").map((line) => line.split(/\s{2,}/));
		expect(header).toEqual(["method", "calls", "per answer", "history_open", "history_page", "sql", "error", "limit", "avg result chars"]);
		expect(rows).toEqual([["h", "4", "4.0", "1", "1", "0", "1", "1", "200"]]);
	});
});

describe("sampleQuestions", () => {
	const asked = ["a", "b", "c", "d", "e"].map((id) => ({ question: q(id, "e1"), visibleInKept: id === "e" }));

	test("picks at most n questions that only the history answers, in asked order", () => {
		const picked = sampleQuestions(asked, 1, 3);
		expect(picked.length).toBe(3);
		expect(picked.some((a) => a.visibleInKept)).toBe(false);
		expect(picked.map((a) => asked.indexOf(a))).toEqual([...picked.map((a) => asked.indexOf(a))].sort());
	});

	test("gives the same pick each time and can differ by cut point", () => {
		const ids = (point: number) => sampleQuestions(asked, point, 2).map((a) => a.question.id);
		expect(ids(1)).toEqual(ids(1));
		expect(new Set([1, 2, 3, 4, 5, 6].map((point) => ids(point).join())).size > 1).toBe(true);
	});
});

describe("page reading", () => {
	test("counts newest-first loops, pages read, and scores by whether all pages were read", () => {
		const record = (questionId: string, grade: AnswerRecord["grade"]): AnswerRecord => ({
			method: "h",
			repeat: 1,
			point: 1,
			questionId,
			type: "rule",
			visibleInKept: false,
			answer: "",
			grade,
			reason: "",
		});
		const text = renderReport(
			[record("q1", "correct"), record("q2", "wrong")],
			[
				{
					method: "h",
					repeat: 1,
					point: 1,
					summaryChars: 1,
					compactionTokens: 1,
					answerTokens: 1,
					toolCalls: 4,
					pageLoops: [
						{ questionIds: ["q1"], pages: [1, 2, 3], totalPages: 3 },
						{ questionIds: ["q2"], pages: [3], totalPages: 3 },
					],
				},
			],
		);
		const sections = text.split("\n\n");
		const at = sections.findIndex((section) => section.startsWith("Page reading"));
		expect(sections[at + 1].split("\n").slice(1).map((line) => line.split(/\s{2,}/))).toEqual([
			["h", "2", "50%", "2.0 of 3.0", "50%", "100% (1)", "0% (1)"],
		]);
	});
});
