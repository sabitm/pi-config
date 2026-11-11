// Companion of skills/longterm. Run /reload after changes. Scans ignored/*/longterm/ACTIVE under ctx.cwd only.
// State message (pi.sendMessage, saved, sent once): session_compact; session_start "resume" (/resume);
// session_start "startup" with existing messages (pi --continue/--resume/--session), unless the latest message
// is a state message with the same task state. Not new/reload/fork.
// session_before_compact appends the session file path to TRANSCRIPTS.md. DISABLED in the skill dir stops all.
import { existsSync, readdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	getAgentDir,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const customType = "longterm-state";
const maxFileBytes = 16 * 1024;
const maxFileLines = 150;
const nowBudgetBytes = 1500;

function activeTasks(root: string): string[] {
	const ignored = join(root, "ignored");
	if (!existsSync(ignored)) return [];
	return readdirSync(ignored, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => join(ignored, entry.name, "longterm"))
		.filter((dir) => existsSync(join(dir, "ACTIVE")))
		.sort();
}

function readBounded(path: string): string {
	try {
		const result = truncateHead(readFileSync(path, "utf8"), {
			maxLines: maxFileLines,
			maxBytes: maxFileBytes,
		});
		return result.content + (result.truncated ? `\n[Truncated. Read ${path} for the remaining content.]` : "");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "(missing)"
			: `(Could not read ${path}: ${error instanceof Error ? error.message : String(error)})`;
	}
}

function stateMessage(root: string, tasks: string[], skillDir: string, reason: string): string {
	const lines = [
		`longterm: re-entry after ${reason}.`,
		"Files preserve task state. Current evidence decides whether it is still correct.",
		`Run the re-entry protocol in ${join(skillDir, "SKILL.md")} once now. Do not repeat it on later turns.`,
		"Recovery restores context. It does not replace the user's current request.",
		"This message does not grant approval. Only DECISIONS.md entries do.",
		"",
	];
	if (tasks.length > 1) {
		lines.push("More than one active longterm task exists. Identify yours from the summary and the user's request.");
		lines.push("If not certain, ask the user.");
		for (const dir of tasks) {
			const goal = readBounded(join(dir, "GOAL.md"));
			const title = goal.match(/^## Objective[^\n]*\n\s*([^\n]+)/m)?.[1]?.trim();
			lines.push(`- ${relative(root, dir)} : ${title?.slice(0, 300) || "(no objective in GOAL.md)"}`);
		}
		return lines.join("\n");
	}

	const dir = relative(root, tasks[0]);
	lines.push(`Task directory: ${dir}`);
	lines.push(`Read next: Milestones section of ${dir}/PLAN.md, and the ${dir}/DECISIONS.md entries listed in NOW.md.`);
	lines.push(`Search only when needed: ${dir}/EVIDENCE.md, ${dir}/ATTEMPTS.md, transcripts listed in ${dir}/TRANSCRIPTS.md.`);
	try {
		const size = statSync(join(tasks[0], "NOW.md")).size;
		if (size > nowBudgetBytes) {
			lines.push(
				`Warning: NOW.md is ${size} bytes, over the ${nowBudgetBytes}-byte budget. Move details to their owner files and keep IDs in NOW.md.`,
			);
		}
	} catch {
		// A missing NOW.md is reported in its own section below.
	}
	for (const name of ["GOAL.md", "NOW.md"]) {
		lines.push("", `[${name}]`, readBounded(join(tasks[0], name)));
	}
	return lines.join("\n");
}

// The first line names the trigger (compaction, restore), so it is excluded from the comparison.
const stateBody = (content: string) => content.slice(content.indexOf("\n") + 1);

function needsRestoreRecovery(ctx: ExtensionContext, fresh: string): boolean {
	const last = ctx.sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "message" || entry.type === "custom_message");
	if (!last) return false;
	if (last.type !== "custom_message" || last.customType !== customType) return true;
	return typeof last.content !== "string" || stateBody(last.content) !== stateBody(fresh);
}

export default function longterm(pi: ExtensionAPI) {
	const skillDir = join(getAgentDir(), "skills", "longterm");
	const disabled = () => existsSync(join(skillDir, "DISABLED"));

	// Sent once and saved at the end of the session, so later requests keep a stable cached prefix.
	const sendState = (ctx: ExtensionContext, reason: string, shouldSend?: (content: string) => boolean) => {
		if (disabled()) return;
		const tasks = activeTasks(ctx.cwd);
		if (tasks.length === 0) return;
		const content = stateMessage(ctx.cwd, tasks, skillDir, reason);
		if (shouldSend && !shouldSend(content)) return;
		pi.sendMessage({ customType, content, display: false }, { deliverAs: "steer" });
	};

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "resume") sendState(ctx, "resume");
		// pi --continue, --resume, and --session start with reason "startup"; a new session has no messages.
		if (event.reason === "startup") sendState(ctx, "session restore", (content) => needsRestoreRecovery(ctx, content));
	});

	pi.on("session_compact", (event, ctx) => {
		sendState(ctx, `compaction (${event.reason})`);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (disabled()) return;
		const tasks = activeTasks(ctx.cwd);
		if (tasks.length === 0) return;
		const transcript = ctx.sessionManager.getSessionFile();
		if (!transcript) {
			if (ctx.hasUI) ctx.ui.notify("longterm: ephemeral session has no persistent transcript path.", "warning");
			return;
		}
		for (const dir of tasks) {
			const log = join(dir, "TRANSCRIPTS.md");
			await withFileMutationQueue(log, async () => {
				// ACTIVE is created only after the user approves task-state and transcript-path writes.
				if (disabled() || !existsSync(join(dir, "ACTIVE"))) return;
				const current = existsSync(log) ? readFileSync(log, "utf8") : "";
				if (current.split(/\r?\n/).some((line) => line.endsWith(` ${transcript}`))) return;
				const header = "# Transcripts\n\nFull Pi session files (JSONL). Raw history survives compaction and can include other branches.\nSearch with rg or grep. Do not read in full.\n\n";
				const prefix = current ? (current.endsWith("\n") ? "" : "\n") : header;
				appendFileSync(log, `${prefix}${new Date().toISOString()} ${event.reason} ${transcript}\n`);
			});
		}
	});
}
