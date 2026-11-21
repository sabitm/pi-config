// Layer 1 eval: replay a recorded session, compact at its recorded cut points with Pi's default compaction, ask
// questions with known answers, and grade them. The opthist method sees the same summary plus the database note,
// and has the history tools. Load with `pi -e <this file>`. It is not discovered automatically.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { uuidv7, type Context, type Message, type Usage } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { History, pageRows } from "../src/db.ts";
import { addUsage, completeJson, type Complete } from "../src/llm.ts";
import { addNote, clipMiddle, contextEdits, entryMessage, fileOpsOf, isUserStart, rowSummaryPrompt, rowSummarySystemPrompt, serializeMessage, type Entry as RenderEntry } from "../src/render.ts";
import { openTool, pageTool } from "../src/tools.ts";
import {
	answerSystemPrompt,
	answerUserPrompt,
	judgePrompt,
	judgeSystemPrompt,
	parseAnswers,
	parseGrades,
	renderContext,
} from "./answer.ts";
import { exactHit, parseQuestions, renderReport, sampleQuestions, selectQuestions, type AnswerRecord, type PointRecord, type Question, type ToolCall } from "./report.ts";
import { branchBefore, compactionEntry, defaultSlices, loadSession, relink, type Entry, type Session } from "./replay.ts";

const methods = ["pi-default", "opthist"] as const;
type Method = (typeof methods)[number];
const maxToolCalls = 20;
const maxToolRounds = 20;
const answerMaxTokens = 8000;
const summaryMaxTokens = 4000;
const toolResultMaxChars = 2000;
const rowMaxChars = 200000;
// The note names this path. The eval database is in memory, and the sql tool stands in for sqlite3.
const notePath = "history.sqlite";

// Pi puts tool guidelines in the live system prompt, so the eval adds them too.
const guidelines = [...pageTool.promptGuidelines, ...openTool.promptGuidelines];

const sqlTool = {
	name: "sql",
	description: "Run one read-only SQL query on the history database and return the result rows as JSON lines.",
	parameters: Type.Object({ query: Type.String({ description: "One SQLite SELECT statement." }) }),
};

interface Options {
	session: string;
	questions: string;
	methods: Method[];
	repeat: number;
	points?: [number, number];
	single: boolean;
	sample?: number;
}

function parseArgs(args: string, cwd: string): Options {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const options: Partial<Options> = { methods: [...methods], repeat: 1, single: false };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const value = () => {
			const next = tokens[++i];
			if (next === undefined) throw new Error(`${token} needs a value`);
			return next;
		};
		if (token === "--methods") {
			const list = value().split(",");
			for (const name of list) if (!methods.includes(name as Method)) throw new Error(`unknown method ${name}. Use ${methods.join(", ")}`);
			options.methods = list as Method[];
		} else if (token === "--repeat") {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 1) throw new Error("--repeat must be a positive integer");
			options.repeat = n;
		} else if (token === "--points") {
			const match = value().match(/^(\d+)(?:-(\d+))?$/);
			if (!match) throw new Error("--points must be N or A-B");
			const from = Number(match[1]);
			const to = match[2] === undefined ? from : Number(match[2]);
			if (from < 1 || to < from) throw new Error("--points range is not valid");
			options.points = [from, to];
		} else if (token === "--single") {
			options.single = true;
		} else if (token === "--sample") {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 1) throw new Error("--sample must be a positive integer");
			options.sample = n;
		} else if (token.startsWith("--")) {
			throw new Error(`unknown option ${token}`);
		} else positional.push(token);
	}
	if (positional.length !== 2) throw new Error("usage: /opthist-eval <session.jsonl> <questions.json> [--methods a,b] [--repeat N] [--points A-B] [--single] [--sample N]");
	return { ...(options as Options), session: resolve(cwd, positional[0]), questions: resolve(cwd, positional[1]) };
}

const textOf = (message: { content: { type: string; text?: string }[] }) =>
	message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");

// Rows of the full recorded branch, keyed by the user entry ID: the raw text, and the position where the row ends.
function recordedRows(session: Session): Map<string, { text: string; end: number }> {
	const rows = new Map<string, { text: string; end: number }>();
	const edits = contextEdits(session.branch as RenderEntry[]);
	const starts = session.branch.flatMap((entry, i) => (isUserStart(entry as RenderEntry) ? [i] : []));
	starts.forEach((start, k) => {
		const end = starts[k + 1] ?? session.branch.length;
		const text = session.branch
			.slice(start, end)
			.map((entry) => entryMessage(entry as RenderEntry, edits))
			.map((message) => (message ? serializeMessage(message, toolResultMaxChars) : ""))
			.filter(Boolean)
			.join("\n\n");
		rows.set(session.branch[start].id, { text: clipMiddle(text, rowMaxChars), end });
	});
	return rows;
}

interface Results {
	answers: AnswerRecord[];
	pointRecords: PointRecord[];
	errors: string[];
}

async function runEval(options: Options, ctx: ExtensionContext, signal: AbortSignal, onRun: (results: Results, runs: number) => void) {
	const model = ctx.model;
	if (!model) throw new Error("no active model");
	const session: Session = loadSession(readFileSync(options.session, "utf8"));
	const questions: Question[] = parseQuestions(JSON.parse(readFileSync(options.questions, "utf8")));
	if (session.points.length === 0) throw new Error("the session has no recorded compaction");
	const [from, to] = options.points ?? [1, session.points.length];
	if (to > session.points.length) throw new Error(`the session has ${session.points.length} cut points`);
	// Fail on unknown entry IDs before any model call.
	for (const point of session.points) selectQuestions(questions, session.positions, point);

	// The judge sends no cache retention. Answer calls allow caching, as live sessions do.
	const completeWith =
		(cache: boolean, maxTokens = answerMaxTokens): Complete =>
		async (system, user) => {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
				{ maxTokens, signal, ...(cache ? {} : { cacheRetention: "none" as const }), sessionId: uuidv7() },
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
			return { text: textOf(response), usage: response.usage, stopReason: response.stopReason };
		};
	const complete = completeWith(false);
	const completeAnswer = completeWith(true);
	const completeSummary = completeWith(false, summaryMaxTokens);

	// Row summaries are written once per session and saved after each row, so a stopped eval keeps them.
	const rows = recordedRows(session);
	const cacheDir = join(dirname(options.questions), "opthist-summaries");
	const cacheFile = join(cacheDir, `${basename(options.session).replace(/\.jsonl$/, "")}.json`);
	const summaries = new Map<string, string>(existsSync(cacheFile) ? Object.entries(JSON.parse(readFileSync(cacheFile, "utf8"))) : []);
	const ensureSummaries = async (at: number) => {
		const missing = [...rows].filter(([id, row]) => row.end <= at && !summaries.has(id));
		for (const [k, [id, row]] of missing.entries()) {
			ctx.ui.notify(`opthist-eval: writing row summary ${k + 1} of ${missing.length}`, "info");
			const reply = await completeSummary(rowSummarySystemPrompt, rowSummaryPrompt(row.text));
			if (!reply.text.trim()) throw new Error(`empty row summary for ${id}`);
			summaries.set(id, reply.text.trim());
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(summaries), null, 2));
		}
	};

	// The live database holds the session file in file order. The replayed branch is one linked chain, which
	// gives the same rows. Summaries exist only for rows that ended before the compaction.
	const buildHistory = (branch: Entry[], at: number): History => {
		const history = new History(":memory:");
		history.sync(branch as RenderEntry[], branch.at(-1)?.id ?? null);
		for (const [id, row] of rows) {
			const summary = summaries.get(id);
			if (row.end <= at && summary) history.setSummary(id, summary, "backfill");
		}
		history.readOnly();
		return history;
	};

	const compactAt = async (branch: Entry[], point: Session["points"][number]) => {
		const slices = defaultSlices(buildSessionProjection(branch as unknown as SessionEntry[]).entries as never, point.firstKeptEntryId);
		const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
		for (const path of slices.previousDetails?.readFiles ?? []) fileOps.read.add(path);
		for (const path of slices.previousDetails?.modifiedFiles ?? []) fileOps.edited.add(path);
		for (const message of [...slices.messagesToSummarize, ...slices.turnPrefixMessages]) {
			for (const op of fileOpsOf(message as never)) (op.modified ? fileOps.edited : fileOps.read).add(op.path);
		}
		return compact(
			{
				firstKeptEntryId: point.firstKeptEntryId,
				messagesToSummarize: slices.messagesToSummarize as never,
				turnPrefixMessages: slices.turnPrefixMessages as never,
				isSplitTurn: slices.isSplitTurn,
				tokensBefore: point.tokensBefore,
				previousSummary: slices.previousSummary,
				fileOps,
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			model,
			undefined,
			undefined,
			undefined,
			signal,
			undefined,
			(m, c, o) => ctx.modelRegistry.streamSimple(m, c as unknown as Context, o),
		);
	};

	const runTool = (history: History, name: string, args: Record<string, unknown>): string => {
		if (name === pageTool.name) return history.page(typeof args.page === "number" ? args.page : undefined);
		if (name === openTool.name) return history.open(Number(args.row), typeof args.part === "number" ? args.part : 1);
		if (name === sqlTool.name) return history.query(String(args.query ?? ""));
		throw new Error(`unknown tool ${name}`);
	};

	const answerWithHistory = async (system: string, user: string, history: History) => {
		const tools = [
			{ name: pageTool.name, description: pageTool.description, parameters: pageTool.parameters },
			{ name: openTool.name, description: openTool.description, parameters: openTool.parameters },
			sqlTool,
		];
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }];
		// One session ID for the whole loop, so each round can reuse the cached prefix of the one before.
		const sessionId = uuidv7();
		let usage: Usage | undefined;
		let calls = 0;
		const log: ToolCall[] = [];
		for (let round = 0; round < maxToolRounds; round++) {
			const response = await ctx.modelRegistry.complete(model, { systemPrompt: system, messages, tools }, { maxTokens: answerMaxTokens, signal, sessionId });
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
			usage = addUsage(usage, response.usage);
			messages.push(response);
			const toolCalls = response.content.filter((part) => part.type === "toolCall");
			if (toolCalls.length === 0) return { text: textOf(response), usage, calls, log };
			for (const call of toolCalls) {
				calls++;
				let text: string;
				let kind: ToolCall["kind"] = "ok";
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				if (calls > maxToolCalls) {
					text = "Tool limit reached. Answer now with the JSON object.";
					kind = "limit";
				} else {
					try {
						text = runTool(history, call.name, args);
					} catch (error) {
						text = error instanceof Error ? error.message : String(error);
						kind = "error";
					}
				}
				log.push({ tool: call.name, args, kind, chars: text.length });
				messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: kind !== "ok", timestamp: Date.now() } as Message);
			}
		}
		throw new Error(`no final answer after ${maxToolRounds} tool rounds`);
	};

	const answers: AnswerRecord[] = [];
	const pointRecords: PointRecord[] = [];
	const errors: string[] = [];
	for (let repeat = 1; repeat <= options.repeat; repeat++) {
		const synthetic = new Map<number, Entry>();
		for (let number = 1; number <= to; number++) {
			const point = session.points[number - 1];
			const branch = branchBefore(session, synthetic, number);
			ctx.ui.notify(`opthist-eval: run ${repeat}, compacting point ${number} of ${to}`, "info");
			const result = await compactAt(branch, point);
			const entry = compactionEntry("pi-default", point, result, false);
			synthetic.set(number, entry);
			if (number < from) continue;

			const answerBranch = relink([...branch, entry]);
			const projected = buildSessionProjection(answerBranch as unknown as SessionEntry[]).messages;
			const all = selectQuestions(questions, session.positions, point);
			const asked = options.sample === undefined ? all : sampleQuestions(all, number, options.sample);
			for (const method of options.methods) {
				const record: PointRecord = {
					method,
					repeat,
					point: number,
					summaryChars: result.summary.length,
					compactionTokens: result.usage?.totalTokens ?? 0,
					answerTokens: 0,
					toolCalls: 0,
				};
				pointRecords.push(record);
				if (asked.length === 0) continue;
				const withHistory = method === "opthist";
				const system = answerSystemPrompt(withHistory, withHistory ? guidelines : []);
				// --single answers each question in its own call. Otherwise one call answers all of them.
				const batches = options.single ? asked.map((a) => [a]) : [asked];
				const given = new Map<string, string>();
				let history: History | undefined;
				try {
					ctx.ui.notify(`opthist-eval: run ${repeat}, ${method}, answering ${asked.length} questions at point ${number}`, "info");
					if (withHistory) {
						await ensureSummaries(point.at);
						history = buildHistory(answerBranch, point.at);
						record.toolLog = [];
						record.pageLoops = [];
					}
					const totalPages = history ? Math.ceil(history.rowCount() / pageRows) : 0;
					for (const batch of batches) {
						const ids = batch.map((a) => a.question.id);
						try {
							if (history) {
								const user = answerUserPrompt(renderContext(addNote(projected, notePath) ?? projected), batch);
								const reply = await answerWithHistory(system, user, history);
								record.toolCalls += reply.calls;
								record.toolLog!.push(...reply.log);
								const pages = reply.log
									.filter((call) => call.tool === pageTool.name && call.kind === "ok")
									.map((call) => ((call.args as { page?: unknown }).page as number | undefined) ?? 1);
								record.pageLoops!.push({ questionIds: ids, pages, totalPages });
								record.answerTokens += reply.usage?.totalTokens ?? 0;
								record.answerCachedTokens = (record.answerCachedTokens ?? 0) + (reply.usage?.cacheRead ?? 0);
								for (const [id, answer] of parseAnswers(reply.text, ids)) given.set(id, answer);
							} else {
								const user = answerUserPrompt(renderContext(projected), batch);
								// completeJson sends its own system prompt, so route through the answer prompt instead.
								const reply = await completeJson((_system, u) => completeAnswer(system, u), user, (text) => parseAnswers(text, ids), signal);
								record.answerTokens += reply.usage?.totalTokens ?? 0;
								record.answerCachedTokens = (record.answerCachedTokens ?? 0) + (reply.usage?.cacheRead ?? 0);
								for (const [id, answer] of reply.value) given.set(id, answer);
							}
						} catch (error) {
							errors.push(`run ${repeat}, ${method}, point ${number}, ${ids.join(",")}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					// Questions whose call failed are not graded.
					const items = asked.filter((a) => given.has(a.question.id)).map((a) => ({ asked: a, answer: given.get(a.question.id)! }));
					if (items.length === 0) continue;
					const ids = items.map((item) => item.asked.question.id);
					const judged = await completeJson((_system, u) => complete(judgeSystemPrompt, u), judgePrompt(items), (text) => parseGrades(text, ids), signal);
					record.answerTokens += judged.usage?.totalTokens ?? 0;
					for (const { asked: a, answer } of items) {
						const grade = judged.value.get(a.question.id)!;
						answers.push({
							method,
							repeat,
							point: number,
							questionId: a.question.id,
							type: a.question.type,
							visibleInKept: a.visibleInKept,
							answer,
							grade: grade.grade,
							reason: grade.reason,
							exact: exactHit(a.question, answer),
							sourceAge: session.positions.get(a.question.sourceEntry)! / point.at,
						});
					}
				} catch (error) {
					errors.push(`run ${repeat}, ${method}, point ${number}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					history?.close();
				}
			}
		}
		onRun({ answers, pointRecords, errors }, repeat);
	}
}

export default function opthistEval(pi: ExtensionAPI) {
	pi.registerCommand("opthist-eval", {
		description: "Replay a session and score pi-default and opthist: /opthist-eval <session.jsonl> <questions.json> [--methods a,b] [--repeat N] [--points A-B] [--single] [--sample N]",
		handler: async (args, ctx) => {
			try {
				const options = parseArgs(args, ctx.cwd);
				const started = Date.now();
				const dir = join(dirname(options.questions), "results");
				mkdirSync(dir, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				let report = "";
				// Rewrites the same files after each run, so a stopped eval keeps every finished run.
				const save = ({ answers, pointRecords, errors }: Results, runs: number) => {
					report = [
						"Eval: opthist-eval",
						`Session: ${options.session}`,
						`Questions: ${options.questions}`,
						`Model: ${ctx.model?.provider}/${ctx.model?.id}. Methods: ${options.methods.join(", ")}. Runs finished: ${runs} of ${options.repeat}. Single: ${options.single}. Sample: ${options.sample ?? "all"}. Minutes: ${((Date.now() - started) / 60000).toFixed(1)}`,
						"",
						renderReport(answers, pointRecords),
						...(errors.length > 0 ? ["", "Errors:", ...errors] : []),
					].join("\n");
					writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ eval: "opthist-eval", options, runsFinished: runs, answers, points: pointRecords, errors }, null, 2));
					writeFileSync(join(dir, `${stamp}.txt`), `${report}\n`);
					if (runs < options.repeat) ctx.ui.notify(`opthist-eval: run ${runs} of ${options.repeat} saved to ${join(dir, `${stamp}.txt`)}`, "info");
				};
				await runEval(options, ctx, new AbortController().signal, save);
				ctx.ui.notify(`opthist-eval: done. Results: ${join(dir, `${stamp}.txt`)}\n\n${report}`, "info");
			} catch (error) {
				ctx.ui.notify(`opthist-eval: failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
