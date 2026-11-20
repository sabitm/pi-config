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

export type ZoomKind = "search" | "search-empty" | "halves" | "page" | "error" | "limit";

export interface ZoomCall {
	id: string;
	query?: string;
	page?: number;
	kind: ZoomKind;
	chars: number;
}

// Classifies by the zoom output text, so it depends on the wording in src/render.ts.
export function zoomKind(text: string, withQuery: boolean, isError: boolean, overLimit: boolean): ZoomKind {
	if (overLimit) return "limit";
	if (isError) return "error";
	if (withQuery) return text.startsWith("No message in ") ? "search-empty" : "search";
	return text.includes("\n\nHalves:\n") ? "halves" : "page";
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
	zoomCalls: number;
	// Rollup shape after this compaction. Only optcompact methods have rows.
	topRows?: number;
	groups?: number;
	zoomLog?: ZoomCall[];
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
			["method", "asked", "score", "correct", "partial", "wrong", "unknown", "exact", "avg summary chars", "compaction tokens", "zoom calls", "cached answer tokens"],
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
					String(mine.reduce((s, p) => s + p.zoomCalls, 0)),
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

	const rollup = methods.filter((method) => points.some((p) => p.method === method && p.topRows !== undefined));
	if (rollup.length > 0)
		sections.push(
			"Rollup by cut point (top-level rows/groups, first run):",
			table(
				["method", ...pointNumbers.map((n) => `#${n}`)],
				rollup.map((method) => [
					method,
					...pointNumbers.map((n) => {
						const p = points.find((r) => r.method === method && r.point === n && r.topRows !== undefined);
						return p ? `${p.topRows}/${p.groups ?? 0}` : "-";
					}),
				]),
			),
		);

	const zoomMethods = methods.filter((method) => points.some((p) => p.method === method && p.zoomLog !== undefined));
	if (zoomMethods.length > 0) {
		const kinds: ZoomKind[] = ["search", "search-empty", "halves", "page", "error", "limit"];
		sections.push(
			"Zoom calls (all runs):",
			table(
				["method", "calls", ...kinds, "avg result chars"],
				zoomMethods.map((method) => {
					const log = points.filter((p) => p.method === method).flatMap((p) => p.zoomLog ?? []);
					const answered = log.filter((call) => call.kind !== "limit");
					return [
						method,
						String(log.length),
						...kinds.map((kind) => String(log.filter((call) => call.kind === kind).length)),
						String(answered.length === 0 ? 0 : Math.round(answered.reduce((sum, call) => sum + call.chars, 0) / answered.length)),
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
