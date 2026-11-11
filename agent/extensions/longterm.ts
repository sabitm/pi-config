import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	getAgentDir,
	truncateHead,
	withFileMutationQueue,
	type ContextEvent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type ContextMessage = ContextEvent["messages"][number];

const customType = "longterm-state";
const maxFileBytes = 16 * 1024;
const maxFileLines = 150;

function activeTasks(root: string): string[] {
	const ignored = join(root, "ignored");
	if (!existsSync(ignored)) return [];
	return readdirSync(ignored, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => join(ignored, entry.name, "longterm"))
		.filter((dir) => existsSync(join(dir, "ACTIVE")))
		.sort();
}

function fileSnapshot(path: string): string {
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

function taskContext(root: string, tasks: string[], skillDir: string, reason: string): string {
	const lines = [
		`longterm: ${reason}. Files on disk are the source of truth. The summary is lossy.`,
		`Read and follow the re-entry protocol in ${join(skillDir, "SKILL.md")}.`,
		"This snapshot does not grant approval. Verify approved scope in DECISIONS.md before making changes.",
		"",
	];
	if (tasks.length > 1) {
		lines.push("More than one active longterm task exists. Identify yours from the summary and the user's request.");
		lines.push("If not certain, ask the user.");
		for (const dir of tasks) {
			const goal = fileSnapshot(join(dir, "GOAL.md"));
			const title = goal.match(/^## Objective[^\n]*\n\s*([^\n]+)/m)?.[1]?.trim();
			lines.push(`- ${relative(root, dir)} : ${title?.slice(0, 300) || "(no objective in GOAL.md)"}`);
		}
		return lines.join("\n");
	}

	const dir = relative(root, tasks[0]);
	lines.push(`Task directory: ${dir}`);
	lines.push(`Read next: ${dir}/PLAN.md, last entries of ${dir}/DECISIONS.md and ${dir}/ATTEMPTS.md`);
	lines.push(`Lost details: search the session files listed in ${dir}/TRANSCRIPTS.md. Do not read them in full.`);
	for (const name of ["GOAL.md", "NOW.md"]) {
		lines.push("", `[${name}]`, fileSnapshot(join(tasks[0], name)));
	}
	return lines.join("\n");
}

export default function longterm(pi: ExtensionAPI) {
	const skillDir = join(getAgentDir(), "skills", "longterm");
	const disabled = () => existsSync(join(skillDir, "DISABLED"));
	let snapshot: ContextMessage | undefined;
	let taskKey = "";
	let reason = "session re-entry";

	pi.on("session_start", (event) => {
		snapshot = undefined;
		taskKey = "";
		reason = `session re-entry (${event.reason})`;
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

	pi.on("session_compact", () => {
		snapshot = undefined;
		reason = "context was compacted";
	});

	pi.on("context", (event, ctx) => {
		if (disabled()) {
			snapshot = undefined;
			taskKey = "";
			return;
		}
		const tasks = activeTasks(ctx.cwd);
		const nextKey = JSON.stringify([ctx.cwd, ...tasks]);
		if (nextKey !== taskKey) {
			snapshot = undefined;
			taskKey = nextKey;
		}
		if (tasks.length === 0) return;
		if (!snapshot) {
			snapshot = {
				role: "custom",
				customType,
				content: taskContext(ctx.cwd, tasks, skillDir, reason),
				display: false,
				timestamp: Date.now(),
			};
		}
		const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== customType);
		const index = messages.findLastIndex((message) => message.role === "compactionSummary") + 1;
		// Keep the snapshot in a stable prefix. One-shot context edits are not persisted by Pi.
		messages.splice(index, 0, snapshot);
		return { messages };
	});
}
