import { describe, expect, test } from "bun:test";
import type { LeafJob, MergeJob, RowNode } from "../src/rows.ts";
import { completeJson, leafLimit, leafPrompt, mergeLimit, mergePrompt, parseJsonObject } from "../src/summarize.ts";

const node = (n: number, summary: string): RowNode => ({ lo: n, hi: n, firstEntryId: `a${n}`, lastEntryId: `b${n}`, summary });

const job = (chars: number, extend?: RowNode): LeafJob => ({
	key: "r1",
	group: { firstEntryId: "a1", lastEntryId: "b1", texts: ["x".repeat(chars)], continues: Boolean(extend), partial: false },
	extend,
});

const merge = (a: number, b: number): MergeJob => ({ key: "m1", a: node(1, "x".repeat(a)), b: node(2, "x".repeat(b)) });

describe("leafLimit", () => {
	test("scales with the row size between the floor and the cap", () => {
		expect(leafLimit(job(5000))).toBe(400);
		expect(leafLimit(job(64000))).toBe(640);
		expect(leafLimit(job(300000))).toBe(2000);
	});

	test("a continued row keeps at least the length of its previous summary", () => {
		expect(leafLimit(job(5000, node(1, "x".repeat(1200))))).toBe(1200);
		expect(leafLimit(job(5000, node(1, "x".repeat(3000))))).toBe(2000);
		expect(leafLimit(job(150000, node(1, "x".repeat(500))))).toBe(1500);
	});
});

describe("mergeLimit", () => {
	test("is 60% of both summaries between the floor and the cap", () => {
		expect(mergeLimit(merge(400, 400))).toBe(600);
		expect(mergeLimit(merge(1000, 1000))).toBe(1200);
		expect(mergeLimit(merge(2000, 2000))).toBe(2000);
	});
});

describe("prompts", () => {
	test("each row and each merge item states its limit", () => {
		expect(leafPrompt([job(64000)], "", 1000000)).toContain('<row key="r1" max-chars="640">');
		expect(mergePrompt([merge(1000, 1000)])).toContain('<item key="m1" max-chars="1200">');
	});
});

describe("completeJson", () => {
	test("a parse failure names the stop reason, output tokens, and response edges", async () => {
		const text = `start-${"x".repeat(1000)}\n-end`;
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const usage = { input: 1, output: 16000, cacheRead: 0, cacheWrite: 0, totalTokens: 16001, cost };
		const failing = completeJson(
			async () => ({ text, usage, stopReason: "length" }),
			"u",
			() => {
				throw new Error("response has no JSON object");
			},
			new AbortController().signal,
		);
		await expect(failing).rejects.toThrow(/response has no JSON object\. stop=length output tokens=16000 chars=1011 start="start-x+" end="x+ -end"/);
	});
});

describe("parseJsonObject", () => {
	test("ignores an extra closing brace and text around the object", () => {
		expect(parseJsonObject('{"nodes":{"m1":"a"}}}')).toEqual({ nodes: { m1: "a" } });
		expect(parseJsonObject('Here:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
	});

	test("does not count braces or escaped quotes inside strings", () => {
		expect(parseJsonObject('{"a":"x } \\" { y"} trailing }')).toEqual({ a: 'x } " { y' });
	});

	test("tries the next object when the first one does not parse", () => {
		expect(parseJsonObject('{not json} {"b":2}')).toEqual({ b: 2 });
	});

	test("fails when no object exists", () => {
		expect(() => parseJsonObject("no json here")).toThrow("response has no JSON object");
		expect(() => parseJsonObject('{"open": 1')).toThrow("response has no JSON object");
	});
});
