// Layer 1 eval: replay a recorded session, compact at its recorded cut points with each method, ask questions
// with known answers, and grade them. Load with `pi -e <this file>`. It is not discovered automatically.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { uuidv7, type Context, type Message, type Usage } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactRows, zoom } from "../index.ts";
import { fileOpsOf } from "../src/render.ts";
import { parseState, walk } from "../src/rows.ts";
import { addUsage, completeJson, type Complete } from "../src/summarize.ts";
import {
	answerSystemPrompt,
	answerUserPrompt,
	judgePrompt,
	judgeSystemPrompt,
	parseAnswers,
	parseGrades,
	renderContext,
} from "./answer.ts";
import { exactHit, parseQuestions, renderReport, selectQuestions, type AnswerRecord, type PointRecord, type Question } from "./report.ts";
import { branchBefore, compactionEntry, defaultSlices, loadSession, relink, type Entry, type Session } from "./replay.ts";

const methods = ["pi-default", "optcompact", "optcompact+zoom"] as const;
type Method = (typeof methods)[number];
const compactorOf = (method: Method) => (method === "pi-default" ? "pi-default" : "optcompact");
const maxZoomCalls = 6;
const maxToolRounds = 12;
const answerMaxTokens = 8000;

interface Options {
	session: string;
	questions: string;
	methods: Method[];
	repeat: number;
	points?: [number, number];
}

function parseArgs(args: string, cwd: string): Options {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const options: Partial<Options> = { methods: [...methods], repeat: 1 };
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
		} else if (token.startsWith("--")) {
			throw new Error(`unknown option ${token}`);
		} else positional.push(token);
	}
	if (positional.length !== 2) throw new Error("usage: /optcompact-eval <session.jsonl> <questions.json> [--methods a,b] [--repeat N] [--points A-B]");
	return { ...(options as Options), session: resolve(cwd, positional[0]), questions: resolve(cwd, positional[1]) };
}

function fakeContext(ctx: ExtensionContext, cwd: string, branch: Entry[]): ExtensionContext {
	return {
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		hasUI: false,
		ui: ctx.ui,
		cwd,
		sessionManager: { getCwd: () => cwd, getBranch: () => branch },
	} as unknown as ExtensionContext;
}

const textOf = (message: { content: { type: string; text?: string }[] }) =>
	message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");

function rollupOf(details: unknown): { topRows?: number; groups?: number } {
	const state = parseState(details);
	if (!state) return {};
	let groups = 0;
	for (const node of walk(state.nodes)) if (node.children) groups++;
	return { topRows: state.nodes.length, groups };
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

	const complete: Complete = async (system, user) => {
		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
			{ maxTokens: answerMaxTokens, signal, cacheRetention: "none", sessionId: uuidv7() },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
		return { text: textOf(response), usage: response.usage };
	};

	const compactAt = async (compactor: string, branch: Entry[], point: Session["points"][number]) => {
		if (compactor === "optcompact") {
			const event = {
				type: "session_before_compact",
				preparation: { firstKeptEntryId: point.firstKeptEntryId, tokensBefore: point.tokensBefore },
				branchEntries: branch,
				reason: "threshold",
				willRetry: false,
				signal,
			} as unknown as SessionBeforeCompactEvent;
			return compactRows(event, fakeContext(ctx, session.cwd, branch));
		}
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

	const answerWithZoom = async (system: string, user: string, branch: Entry[]) => {
		const fake = fakeContext(ctx, session.cwd, branch);
		const tools = [
			{
				name: "zoom",
				description: "Show more detail for a row ID from the compaction summary. A group ID (#A-B) returns its two halves. A row ID (#N) returns its full messages, in pages.",
				parameters: Type.Object({ id: Type.String(), page: Type.Optional(Type.Integer({ minimum: 1 })) }),
			},
		];
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }];
		let usage: Usage | undefined;
		let calls = 0;
		for (let round = 0; round < maxToolRounds; round++) {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: system, messages, tools },
				{ maxTokens: answerMaxTokens, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
			usage = addUsage(usage, response.usage);
			messages.push(response);
			const toolCalls = response.content.filter((part) => part.type === "toolCall");
			if (toolCalls.length === 0) return { text: textOf(response), usage, calls };
			for (const call of toolCalls) {
				calls++;
				let text: string;
				let isError = false;
				if (calls > maxZoomCalls) {
					text = "Zoom limit reached. Answer now with the JSON object.";
					isError = true;
				} else {
					try {
						const args = call.arguments as { id?: unknown; page?: unknown };
						text = zoom(fake, String(args.id ?? ""), typeof args.page === "number" ? args.page : 1);
					} catch (error) {
						text = error instanceof Error ? error.message : String(error);
						isError = true;
					}
				}
				messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() } as Message);
			}
		}
		throw new Error(`no final answer after ${maxToolRounds} tool rounds`);
	};

	const answers: AnswerRecord[] = [];
	const pointRecords: PointRecord[] = [];
	const errors: string[] = [];
	const compactors = [...new Set(options.methods.map(compactorOf))];
	for (let repeat = 1; repeat <= options.repeat; repeat++) {
		for (const compactor of compactors) {
			const synthetic = new Map<number, Entry>();
			for (let number = 1; number <= to; number++) {
				const point = session.points[number - 1];
				const branch = branchBefore(session, synthetic, number);
				ctx.ui.notify(`optcompact-eval: run ${repeat}, ${compactor}, compacting point ${number} of ${to}`, "info");
				const result = await compactAt(compactor, branch, point);
				const entry = compactionEntry(compactor, point, result, compactor !== "pi-default");
				synthetic.set(number, entry);
				if (number < from) continue;

				const answerBranch = relink([...branch, entry]);
				const context = renderContext(buildSessionProjection(answerBranch as unknown as SessionEntry[]).messages);
				const asked = selectQuestions(questions, session.positions, point);
				for (const method of options.methods.filter((m) => compactorOf(m) === compactor)) {
					const record: PointRecord = {
						method,
						repeat,
						point: number,
						summaryChars: result.summary.length,
						compactionTokens: result.usage?.totalTokens ?? 0,
						answerTokens: 0,
						zoomCalls: 0,
						...rollupOf(result.details),
					};
					pointRecords.push(record);
					if (asked.length === 0) continue;
					try {
						ctx.ui.notify(`optcompact-eval: run ${repeat}, ${method}, answering ${asked.length} questions at point ${number}`, "info");
						const ids = asked.map((a) => a.question.id);
						const system = answerSystemPrompt(method === "optcompact+zoom");
						const user = answerUserPrompt(context, asked);
						let given: Map<string, string>;
						if (method === "optcompact+zoom") {
							const reply = await answerWithZoom(system, user, answerBranch);
							record.zoomCalls = reply.calls;
							record.answerTokens += reply.usage?.totalTokens ?? 0;
							given = parseAnswers(reply.text, ids);
						} else {
							// completeJson sends the summarizer system prompt, so route through the answer prompt instead.
							const reply = await completeJson((_system, u) => complete(system, u), user, (text) => parseAnswers(text, ids), signal);
							record.answerTokens += reply.usage?.totalTokens ?? 0;
							given = reply.value;
						}
						const items = asked.map((a) => ({ asked: a, answer: given.get(a.question.id)! }));
						const judged = await completeJson(
							(_system, user) => complete(judgeSystemPrompt, user),
							judgePrompt(items),
							(text) => parseGrades(text, ids),
							signal,
						);
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
							});
						}
					} catch (error) {
						errors.push(`run ${repeat}, ${method}, point ${number}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
		}
		onRun({ answers, pointRecords, errors }, repeat);
	}
}

export default function optcompactEval(pi: ExtensionAPI) {
	pi.registerCommand("optcompact-eval", {
		description: "Replay a session and score compaction methods: /optcompact-eval <session.jsonl> <questions.json> [--methods a,b] [--repeat N] [--points A-B]",
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
						`Session: ${options.session}`,
						`Questions: ${options.questions}`,
						`Model: ${ctx.model?.provider}/${ctx.model?.id}. Methods: ${options.methods.join(", ")}. Runs finished: ${runs} of ${options.repeat}. Minutes: ${((Date.now() - started) / 60000).toFixed(1)}`,
						"",
						renderReport(answers, pointRecords),
						...(errors.length > 0 ? ["", "Errors:", ...errors] : []),
					].join("\n");
					writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ options, runsFinished: runs, answers, points: pointRecords, errors }, null, 2));
					writeFileSync(join(dir, `${stamp}.txt`), `${report}\n`);
					if (runs < options.repeat) ctx.ui.notify(`optcompact-eval: run ${runs} of ${options.repeat} saved to ${join(dir, `${stamp}.txt`)}`, "info");
				};
				await runEval(options, ctx, new AbortController().signal, save);
				ctx.ui.notify(`optcompact-eval: done. Results: ${join(dir, `${stamp}.txt`)}\n\n${report}`, "info");
			} catch (error) {
				ctx.ui.notify(`optcompact-eval: failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
