// Copies every session entry into one SQLite database per session, the single source of truth for the history.
// Pi's own compaction stays. The context event adds a note to the compaction summary that points to the database.
// The main model saves one summary per row with row_summary, and reads history back with history_page and
// history_open. Rows are not merged.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { History, listSessions, resolveSession } from "./src/db.ts";
import { addNote, type Entry, isUserStart, rowSummaryPrompt, rowSummarySystemPrompt } from "./src/render.ts";
import { openTool, pageTool, rowSummaryTool, sessionsTool } from "./src/tools.ts";

const databaseDir = join(getAgentDir(), "opthist");
const backfillToolResultChars = 2000;
const backfillMaxChars = 200000;
const backfillMaxTokens = 4000;

function parseLimit(args: string): number | undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const n = Number(tokens[1]);
	if (tokens.length !== 2 || tokens[0] !== "--limit" || !Number.isInteger(n) || n < 1) throw new Error("usage: /opthist-backfill [--limit N]");
	return n;
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function opthist(pi: ExtensionAPI) {
	let history: History | undefined;
	let sessionId: string | undefined;

	// A session without a file (--no-session) gets an in-memory database.
	const open = (ctx: ExtensionContext): History => {
		const manager = ctx.sessionManager;
		if (history && sessionId === manager.getSessionId()) return history;
		history?.close();
		sessionId = manager.getSessionId();
		let path = ":memory:";
		if (manager.getSessionFile()) {
			mkdirSync(databaseDir, { recursive: true });
			path = join(databaseDir, `${sessionId}.sqlite`);
		}
		history = new History(path);
		return history;
	};

	const sync = (ctx: ExtensionContext): History => {
		const manager = ctx.sessionManager;
		const target = open(ctx);
		target.sync(manager.getEntries() as unknown as Entry[], manager.getLeafId(), { session_id: manager.getSessionId(), cwd: manager.getCwd() });
		return target;
	};

	const syncQuietly = (ctx: ExtensionContext) => {
		try {
			sync(ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`opthist: sync failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => syncQuietly(ctx));
	pi.on("turn_end", (_event, ctx) => syncQuietly(ctx));
	pi.on("agent_end", (_event, ctx) => syncQuietly(ctx));
	pi.on("session_shutdown", () => {
		history?.close();
		history = undefined;
		sessionId = undefined;
	});

	pi.on("context", (event, ctx) => {
		const messages = addNote(event.messages, open(ctx).path);
		return messages ? { messages } : undefined;
	});

	pi.registerTool({
		...rowSummaryTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = sync(ctx);
			const user = ctx.sessionManager.getBranch().findLast((entry) => isUserStart(entry as unknown as Entry));
			if (!user) throw new Error("This branch has no user message.");
			const summary = params.summary.trim();
			if (!summary) throw new Error("The summary is empty.");
			target.setSummary(user.id, summary);
			return textResult(`Saved the summary of row #${target.rowOf(user.id)}.`);
		},
	});

	// Another session's database opens read-only for one call and closes after it.
	const readHistory = (ctx: ExtensionContext, session: string | undefined, read: (target: History) => string): string => {
		const current = sync(ctx);
		const manager = ctx.sessionManager;
		const path = resolveSession(session, { id: manager.getSessionId(), path: current.path }, databaseDir, manager.getCwd());
		if (!path) return read(current);
		const other = new History(path, { readOnly: true });
		try {
			return `${other.sessionLine()}\n\n${read(other)}`;
		} finally {
			other.close();
		}
	};

	pi.registerTool({
		...pageTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(readHistory(ctx, params.session, (target) => target.page(params.page)));
		},
	});

	pi.registerTool({
		...openTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(readHistory(ctx, params.session, (target) => target.open(params.row, params.part ?? 1)));
		},
	});

	pi.registerTool({
		...sessionsTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(listSessions(databaseDir, sync(ctx), params.page));
		},
	});

	pi.registerCommand("opthist-backfill", {
		description: "Write the missing row summaries of this session with the current model, newest first: /opthist-backfill [--limit N]",
		handler: async (args, ctx) => {
			try {
				const limit = parseLimit(args);
				if (!ctx.isIdle()) throw new Error("The agent is working. Run the command when it is idle.");
				const model = ctx.model;
				if (!model) throw new Error("no active model");
				const target = sync(ctx);
				const rows = target.rowsWithoutSummary().slice(0, limit);
				if (rows.length === 0) {
					ctx.ui.notify("opthist-backfill: no row needs a summary.", "info");
					return;
				}
				const name = `${model.provider}/${model.id}`;
				const confirmed = await ctx.ui.confirm(
					"opthist backfill",
					`${rows.length} rows have no summary. Write them with ${name}? This makes ${rows.length} model calls.`,
				);
				if (!confirmed) return;
				// Half of the context window, at 4 characters for each token.
				const maxChars = Math.min(backfillMaxChars, (model.contextWindow || backfillMaxChars) * 2);
				const failed: string[] = [];
				let written = 0;
				let stopped = false;
				try {
					for (const [k, { row, userEntryId }] of rows.entries()) {
						// session_shutdown or a session switch replaces the database this loop writes to.
						if (history !== target) {
							stopped = true;
							break;
						}
						ctx.ui.setStatus("opthist", `opthist backfill: ${k + 1} of ${rows.length}`);
						try {
							const user = rowSummaryPrompt(target.rowText(row, backfillToolResultChars, maxChars));
							const response = await ctx.modelRegistry.complete(
								model,
								{ systemPrompt: rowSummarySystemPrompt, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
								{ maxTokens: backfillMaxTokens, cacheRetention: "none", sessionId: uuidv7() },
							);
							if (response.stopReason === "error" || response.stopReason === "aborted") {
								throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
							}
							const summary = response.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
								.trim();
							if (!summary) throw new Error("empty summary");
							if (history !== target) {
								stopped = true;
								break;
							}
							target.setSummary(userEntryId, summary, "backfill");
							written++;
						} catch (error) {
							failed.push(`#${row} (${error instanceof Error ? error.message : String(error)})`);
						}
					}
				} finally {
					ctx.ui.setStatus("opthist", undefined);
				}
				const parts = [`opthist-backfill: wrote ${written} of ${rows.length} summaries.`];
				if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.join(", ")}.`);
				if (stopped) parts.push("Stopped: the session changed.");
				ctx.ui.notify(parts.join(" "), failed.length > 0 || stopped ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`opthist-backfill: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
