// Copies every session entry into one SQLite database per session, the single source of truth for the history.
// Pi's own compaction stays. The context event adds a note to the compaction summary that points to the database.
// The main model saves one summary per row with row_summary, and reads history back with history_page and
// history_open. Rows are not merged.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { History } from "./src/db.ts";
import { addNote, type Entry, isUserStart } from "./src/render.ts";
import { openTool, pageTool, rowSummaryTool } from "./src/tools.ts";

const databaseDir = join(getAgentDir(), "opthist");

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

	pi.registerTool({
		...pageTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(sync(ctx).page(params.page));
		},
	});

	pi.registerTool({
		...openTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return textResult(sync(ctx).open(params.row, params.part ?? 1));
		},
	});
}
