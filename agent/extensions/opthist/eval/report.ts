// Question selection, grading totals, and the text report. No Pi imports.

export const questionTypes = ["rule", "scope", "value", "decision", "state"] as const;
export type QuestionType = (typeof questionTypes)[number];
export const grades = ["correct", "partial", "wrong", "unknown"] as const;
export type Grade = (typeof grades)[number];

export interface Question {
	id: string;
	type: QuestionType;
	question: string;
	answer: string;
	mustContain?: string[];
	// Entry where the fact first appears. The question is asked only at cut points after it.
	sourceEntry: string;
	// Entry where the fact stops being true, for facts that change (for example the current scope).
	validUntil?: string;
}

export interface CutPoint {
	// 1-based number of the recorded compaction.
	number: number;
	// Positions on the raw branch: where the compaction entry was, and its first kept entry.
	at: number;
	cut: number;
}

export interface Asked {
	question: Question;
	// The source is after the cut, so the kept messages show it and the summary is not needed.
	visibleInKept: boolean;
}

export function parseQuestions(value: unknown): Question[] {
	const list = (value as { questions?: unknown })?.questions ?? value;
	if (!Array.isArray(list)) throw new Error("questions file must be a JSON array or {questions: [...]}");
	const ids = new Set<string>();
	return list.map((raw, i) => {
		const q = raw as Partial<Question>;
		const where = `question ${i + 1}${typeof q?.id === "string" ? ` (${q.id})` : ""}`;
		for (const field of ["id", "question", "answer", "sourceEntry"] as const) {
			if (typeof q?.[field] !== "string" || !q[field]!.trim()) throw new Error(`${where}: "${field}" must be a non-empty string`);
		}
		if (!questionTypes.includes(q.type as QuestionType)) throw new Error(`${where}: "type" must be one of ${questionTypes.join(", ")}`);
		if (q.validUntil !== undefined && typeof q.validUntil !== "string") throw new Error(`${where}: "validUntil" must be a string`);
		if (q.mustContain !== undefined && (!Array.isArray(q.mustContain) || q.mustContain.some((s) => typeof s !== "string" || !s))) {
			throw new Error(`${where}: "mustContain" must be a list of non-empty strings`);
		}
		if (ids.has(q.id!)) throw new Error(`${where}: duplicate id`);
		ids.add(q.id!);
		return q as Question;
	});
}

export function selectQuestions(questions: Question[], positions: Map<string, number>, point: CutPoint): Asked[] {
	const position = (id: string, field: string, q: Question) => {
		const value = positions.get(id);
		if (value === undefined) throw new Error(`question ${q.id}: ${field} ${id} is not on the session branch`);
		return value;
	};
	const asked: Asked[] = [];
	for (const question of questions) {
		const source = position(question.sourceEntry, "sourceEntry", question);
		if (source >= point.at) continue;
		if (question.validUntil !== undefined && position(question.validUntil, "validUntil", question) <= point.at) continue;
		asked.push({ question, visibleInKept: source >= point.cut });
	}
	return asked;
}

// FNV-1a. Only needs to be stable across runs, not strong.
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return h;
}

// At most n questions that only the history answers, the same ones for every method and run. Keeps asked order.
export function sampleQuestions(asked: Asked[], point: number, n: number): Asked[] {
	const picked = new Set(
		asked
			.filter((a) => !a.visibleInKept)
			.map((a) => ({ a, h: hash(`${point}#${a.question.id}`) }))
			.sort((x, y) => x.h - y.h)
			.slice(0, n)
			.map((x) => x.a),
	);
	return asked.filter((a) => picked.has(a));
}

export const exactHit = (question: Question, answer: string) =>
	question.mustContain === undefined
		? undefined
		: question.mustContain.every((text) => answer.toLowerCase().includes(text.toLowerCase()));

export interface AnswerRecord {
	method: string;
	repeat: number;
	point: number;
	questionId: string;
	type: QuestionType;
	visibleInKept: boolean;
	answer: string;
	grade: Grade;
	reason: string;
	exact?: boolean;
	// Position of the source in the history before the compaction: 0 is the oldest entry, 1 is just before it.
	sourceAge?: number;
}

export type CallKind = "ok" | "error" | "limit";

export interface ToolCall {
	tool: string;
	args: unknown;
	kind: CallKind;
	chars: number;
}

// One answer call with tools. pages lists the page read by each history_page call in order. Page 1 is the newest.
export interface PageLoop {
	questionIds: string[];
	pages: number[];
	totalPages: number;
}

export interface PointRecord {
	method: string;
	repeat: number;
	point: number;
	summaryChars: number;
	compactionTokens: number;
	answerTokens: number;
	// Cache reads in the answer calls only. The judge is not cached.
	answerCachedTokens?: number;
	toolCalls: number;
	toolLog?: ToolCall[];
	pageLoops?: PageLoop[];
}

interface Tally {
	asked: number;
	counts: Record<Grade, number>;
	exactAsked: number;
	exactHits: number;
}

const emptyTally = (): Tally => ({ asked: 0, counts: { correct: 0, partial: 0, wrong: 0, unknown: 0 }, exactAsked: 0, exactHits: 0 });

function tally(records: AnswerRecord[]): Tally {
	const result = emptyTally();
	for (const record of records) {
		result.asked++;
		result.counts[record.grade]++;
		if (record.exact !== undefined) {
			result.exactAsked++;
			if (record.exact) result.exactHits++;
		}
	}
	return result;
}

// Partial answers count half.
export const score = (t: Tally) => (t.asked === 0 ? 0 : (t.counts.correct + 0.5 * t.counts.partial) / t.asked);

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const pad = (cells: string[], widths: number[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();

function table(header: string[], rows: string[][]): string {
	const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));
	return [pad(header, widths), ...rows.map((row) => pad(row, widths))].join("\n");
}

export function renderReport(answers: AnswerRecord[], points: PointRecord[]): string {
	const methods = [...new Set(points.map((p) => p.method))];
	const pointNumbers = [...new Set(points.map((p) => p.point))].sort((a, b) => a - b);
	const sections: string[] = [];

	sections.push(
		"Questions answered from the summary (source before the cut):",
		table(
			["method", "asked", "score", "correct", "partial", "wrong", "unknown", "exact", "avg summary chars", "compaction tokens", "tool calls", "cached answer tokens"],
			methods.map((method) => {
				const t = tally(answers.filter((a) => a.method === method && !a.visibleInKept));
				const mine = points.filter((p) => p.method === method);
				const avgChars = mine.length === 0 ? 0 : Math.round(mine.reduce((s, p) => s + p.summaryChars, 0) / mine.length);
				return [
					method,
					String(t.asked),
					pct(score(t)),
					String(t.counts.correct),
					String(t.counts.partial),
					String(t.counts.wrong),
					String(t.counts.unknown),
					t.exactAsked === 0 ? "-" : `${t.exactHits}/${t.exactAsked}`,
					String(avgChars),
					String(mine.reduce((s, p) => s + p.compactionTokens, 0)),
					String(mine.reduce((s, p) => s + p.toolCalls, 0)),
					String(mine.reduce((s, p) => s + (p.answerCachedTokens ?? 0), 0)),
				];
			}),
		),
	);

	sections.push(
		"Score by question type (source before the cut):",
		table(
			["method", ...questionTypes],
			methods.map((method) => [
				method,
				...questionTypes.map((type) => {
					const t = tally(answers.filter((a) => a.method === method && !a.visibleInKept && a.type === type));
					return t.asked === 0 ? "-" : `${pct(score(t))} (${t.asked})`;
				}),
			]),
		),
	);

	sections.push(
		"Score by cut point (source before the cut):",
		table(
			["method", ...pointNumbers.map((n) => `#${n}`)],
			methods.map((method) => [
				method,
				...pointNumbers.map((n) => {
					const t = tally(answers.filter((a) => a.method === method && !a.visibleInKept && a.point === n));
					return t.asked === 0 ? "-" : `${pct(score(t))} (${t.asked})`;
				}),
			]),
		),
	);

	const ageGroups: [string, (age: number) => boolean][] = [
		["old", (age) => age < 1 / 3],
		["middle", (age) => age >= 1 / 3 && age < 2 / 3],
		["recent", (age) => age >= 2 / 3],
	];
	const aged = methods.filter((method) => answers.some((a) => a.method === method && a.sourceAge !== undefined));
	if (aged.length > 0)
		sections.push(
			"Score by source age (source before the cut; old is the first third of the history, recent the last third):",
			table(
				["method", ...ageGroups.map(([name]) => name)],
				aged.map((method) => [
					method,
					...ageGroups.map(([, inGroup]) => {
						const t = tally(answers.filter((a) => a.method === method && !a.visibleInKept && a.sourceAge !== undefined && inGroup(a.sourceAge)));
						return t.asked === 0 ? "-" : `${pct(score(t))} (${t.asked})`;
					}),
				]),
			),
		);

	const toolMethods = methods.filter((method) => points.some((p) => p.method === method && p.toolLog !== undefined));
	if (toolMethods.length > 0) {
		const tools = [...new Set(points.flatMap((p) => (p.toolLog ?? []).filter((call) => call.kind !== "limit").map((call) => call.tool)))].sort();
		sections.push(
			"Tool calls (all runs; errors and limit are not counted by tool):",
			table(
				["method", "calls", "per answer", ...tools, "error", "limit", "avg result chars"],
				toolMethods.map((method) => {
					const mine = points.filter((p) => p.method === method && p.toolLog !== undefined);
					const log = mine.flatMap((p) => p.toolLog ?? []);
					const ok = log.filter((call) => call.kind === "ok");
					return [
						method,
						String(log.length),
						(mine.length === 0 ? 0 : log.length / mine.length).toFixed(1),
						...tools.map((tool) => String(ok.filter((call) => call.tool === tool).length)),
						String(log.filter((call) => call.kind === "error").length),
						String(log.filter((call) => call.kind === "limit").length),
						String(ok.length === 0 ? 0 : Math.round(ok.reduce((sum, call) => sum + call.chars, 0) / ok.length)),
					];
				}),
			),
		);
	}

	const loopMethods = methods.filter((method) => points.some((p) => p.method === method && p.pageLoops !== undefined));
	if (loopMethods.length > 0) {
		sections.push(
			"Page reading (all runs; a loop is one answer call; newest first means the first page read was page 1):",
			table(
				["method", "loops", "newest first", "avg pages read", "read all", "score, read all", "score, read fewer"],
				loopMethods.map((method) => {
					const mine = points.filter((p) => p.method === method);
					const loops = mine.flatMap((p) => (p.pageLoops ?? []).map((loop) => ({ p, loop })));
					const read = (loop: PageLoop) => new Set(loop.pages).size;
					const readAll = (loop: PageLoop) => read(loop) >= loop.totalPages;
					const scoreOf = (all: boolean) => {
						const keys = new Set(
							loops.filter(({ loop }) => readAll(loop) === all).flatMap(({ p, loop }) => loop.questionIds.map((id) => `${p.repeat}/${p.point}/${id}`)),
						);
						const t = tally(answers.filter((a) => a.method === method && !a.visibleInKept && keys.has(`${a.repeat}/${a.point}/${a.questionId}`)));
						return t.asked === 0 ? "-" : `${pct(score(t))} (${t.asked})`;
					};
					const n = loops.length;
					const avg = (f: (loop: PageLoop) => number) => (n === 0 ? 0 : loops.reduce((sum, { loop }) => sum + f(loop), 0) / n);
					return [
						method,
						String(n),
						n === 0 ? "-" : pct(loops.filter(({ loop }) => loop.pages[0] === 1).length / n),
						`${avg(read).toFixed(1)} of ${avg((loop) => loop.totalPages).toFixed(1)}`,
						n === 0 ? "-" : pct(loops.filter(({ loop }) => readAll(loop)).length / n),
						scoreOf(true),
						scoreOf(false),
					];
				}),
			),
		);
	}

	sections.push(
		"Control: questions visible in the kept messages:",
		table(
			["method", "asked", "score"],
			methods.map((method) => {
				const t = tally(answers.filter((a) => a.method === method && a.visibleInKept));
				return [method, String(t.asked), t.asked === 0 ? "-" : pct(score(t))];
			}),
		),
	);

	return sections.join("\n\n");
}
