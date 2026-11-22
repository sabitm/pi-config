// The SQLite history: every session entry, the row summaries, and the views that read the current branch.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { clipMiddle, contextEdits, type Entry, entryMessage, entryText, oneLine, openToolName, pageToolName, paginate, serializeMessage, userPrefix } from "./render.ts";

export const pageRows = 20;
export const partChars = 20000;
const requestChars = 300;
const firstRequestChars = 150;
const queryMaxRows = 100;
const queryMaxChars = 20000;

// branch: the parent chain of meta.leaf_id. Ordering by seq is chain order only because Pi appends a child after
// its parent, so sync must insert entries in file order.
// rows: one line for each user message on the branch. A row ends just before the next user message.
// request skips the "[User]: " prefix that entryText writes.
const schema = `
CREATE TABLE IF NOT EXISTS entries (
	seq INTEGER PRIMARY KEY,
	id TEXT NOT NULL UNIQUE,
	parent_id TEXT,
	type TEXT NOT NULL,
	role TEXT,
	timestamp TEXT,
	text TEXT NOT NULL,
	json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS row_summaries (
	user_entry_id TEXT PRIMARY KEY,
	summary TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	source TEXT NOT NULL DEFAULT 'model'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE VIEW IF NOT EXISTS branch AS
WITH RECURSIVE chain(id) AS (
	SELECT value FROM meta WHERE key = 'leaf_id'
	UNION ALL
	SELECT e.parent_id FROM entries e JOIN chain c ON e.id = c.id WHERE e.parent_id IS NOT NULL
)
SELECT e.* FROM entries e JOIN chain c ON e.id = c.id ORDER BY e.seq;
CREATE VIEW IF NOT EXISTS rows AS
WITH b AS (SELECT seq, id, type, role, timestamp, text, LAG(seq) OVER (ORDER BY seq) AS prev_seq FROM branch),
starts AS (
	SELECT seq, id, timestamp, text, ROW_NUMBER() OVER (ORDER BY seq) AS row, LEAD(prev_seq) OVER (ORDER BY seq) AS end_seq
	FROM b WHERE type = 'message' AND role = 'user'
)
SELECT s.row, s.id AS user_entry_id, s.timestamp, s.seq AS first_seq,
	COALESCE(s.end_seq, (SELECT MAX(seq) FROM b)) AS last_seq,
	substr(s.text, ${userPrefix.length + 1}, ${requestChars}) AS request, r.summary
FROM starts s LEFT JOIN row_summaries r ON r.user_entry_id = s.id;
`;

const roleOf = (entry: Entry): string | null => {
	if (entry.type === "message") return (entry.message as { role?: string } | undefined)?.role ?? null;
	if (entry.type === "custom_message") return "custom";
	return null;
};

export type SummarySource = "model" | "backfill";

const requiredObjects = ["table:entries", "table:row_summaries", "table:meta", "view:branch", "view:rows"];

// Returns the database path that a session value names, or undefined for the current session.
// A value with "/", a leading "~", or a ".sqlite" end is a path. Otherwise it is a session ID or a unique start of one.
export function resolveSession(value: string | undefined, current: { id: string; path: string }, databaseDir: string, cwd: string): string | undefined {
	const v = value?.trim() ?? "";
	if (!v || v === current.id) return undefined;
	let path: string;
	if (v.includes("/") || v.startsWith("~") || v.endsWith(".sqlite")) {
		path = resolve(cwd, v.startsWith("~") ? join(homedir(), v.slice(1)) : v);
		if (!existsSync(path)) throw new Error(`${path} does not exist.`);
	} else {
		const names = existsSync(databaseDir) ? readdirSync(databaseDir).filter((name) => name.endsWith(".sqlite")) : [];
		const matches = names.includes(`${v}.sqlite`) ? [`${v}.sqlite`] : names.filter((name) => name.startsWith(v));
		if (matches.length === 0) throw new Error(`No opthist database for session "${v}" in ${databaseDir}.`);
		if (matches.length > 1) {
			throw new Error(`Session "${v}" matches several databases: ${matches.map((name) => name.slice(0, -".sqlite".length)).join(", ")}. Give more characters.`);
		}
		path = join(databaseDir, matches[0]);
	}
	return resolve(path) === resolve(current.path) ? undefined : path;
}

const changedAt = (path: string): number => Math.max(...[path, `${path}-wal`].filter(existsSync).map((file) => statSync(file).mtimeMs));

// history_sessions: the current session first, then the other databases in dir by last change, newest first.
// Only the databases on the requested page are opened.
export function listSessions(dir: string, current: History, p = 1): string {
	const currentPath = resolve(current.path);
	const others = (existsSync(dir) ? readdirSync(dir) : [])
		.filter((name) => name.endsWith(".sqlite"))
		.map((name) => join(dir, name))
		.filter((path) => resolve(path) !== currentPath)
		.map((path) => ({ path, changed: changedAt(path) }))
		.sort((a, b) => b.changed - a.changed)
		.map(({ path }) => path);
	const count = others.length + 1;
	const pages = Math.ceil(count / pageRows);
	if (!Number.isInteger(p) || p < 1 || p > pages) throw new Error(`Page ${p} does not exist. Pages: 1 (newest) to ${pages} (oldest).`);
	const start = (p - 1) * pageRows;
	const lines: string[] = [];
	for (let i = start; i < Math.min(count, start + pageRows); i++) {
		if (i === 0) {
			lines.push(current.overview(true));
			continue;
		}
		const path = others[i - 1];
		try {
			// A -wal file means a running Pi process, or one that stopped without a checkpoint: rows can be in it.
			const other = new History(path, { readOnly: true, immutable: !existsSync(`${path}-wal`) });
			try {
				lines.push(other.overview(false));
			} finally {
				other.close();
			}
		} catch (error) {
			lines.push(`${path} | cannot read: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const label = [...(p === 1 ? ["newest"] : []), ...(p === pages ? ["oldest"] : [])].join(" and ");
	const older = p < pages ? `Older sessions: page ${p + 1}.` : "No older sessions.";
	return [
		`Page ${p} of ${pages}${label ? ` (${label})` : ""}: sessions ${start + 1} to ${start + lines.length} of ${count}, this session first, then by last change. ${older}`,
		`Databases: ${join(dir, "<session ID>.sqlite")}. Use a session ID as the session parameter of ${pageToolName} and ${openToolName}.`,
		"",
		...lines,
	].join("\n");
}

const timeOf = (timestamp: unknown) => (typeof timestamp === "string" ? timestamp.slice(0, 16).replace("T", " ") : "");

export class History {
	readonly db: DatabaseSync;
	readonly path: string;
	private known = new Set<string>();

	// readOnly is for another session's database: it may belong to a running Pi process, so it is never changed.
	// immutable is for a database that no process writes: SQLite then creates no -wal and -shm files, but it also
	// ignores an existing -wal file and fails or reads wrong data if the file changes during the read.
	constructor(path: string, options: { readOnly?: boolean; immutable?: boolean } = {}) {
		this.path = path;
		if (options.readOnly) {
			let source: string | URL = path;
			if (options.immutable) {
				source = pathToFileURL(resolve(path));
				source.searchParams.set("immutable", "1");
			}
			this.db = new DatabaseSync(source, { readOnly: true });
			const found = new Set(this.db.prepare("SELECT type || ':' || name AS object FROM sqlite_master").all().map((row) => String(row.object)));
			if (requiredObjects.some((object) => !found.has(object))) {
				this.db.close();
				throw new Error(`${path} is not an opthist database.`);
			}
			return;
		}
		this.db = new DatabaseSync(path);
		// WAL lets sqlite3 read while Pi writes.
		if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(schema);
		// Databases created before the source column existed. Their summaries came from row_summary.
		const columns = this.db.prepare("PRAGMA table_info(row_summaries)").all();
		if (!columns.some((column) => column.name === "source")) this.db.exec("ALTER TABLE row_summaries ADD COLUMN source TEXT NOT NULL DEFAULT 'model'");
		for (const row of this.db.prepare("SELECT id FROM entries").all()) this.known.add(row.id as string);
	}

	// Entries must come in file order (see the schema comment). Entries already stored are skipped.
	sync(entries: Entry[], leafId: string | null, meta: Record<string, string> = {}) {
		const insert = this.db.prepare("INSERT OR IGNORE INTO entries (id, parent_id, type, role, timestamp, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
		const setMeta = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
		const added: string[] = [];
		this.db.exec("BEGIN");
		try {
			for (const entry of entries) {
				if (this.known.has(entry.id)) continue;
				insert.run(entry.id, entry.parentId ?? null, entry.type, roleOf(entry), entry.timestamp ?? null, entryText(entry), JSON.stringify(entry));
				added.push(entry.id);
			}
			for (const [key, value] of Object.entries({ ...meta, leaf_id: leafId ?? "" })) setMeta.run(key, value);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		for (const id of added) this.known.add(id);
	}

	setSummary(userEntryId: string, summary: string, source: SummarySource = "model") {
		this.db
			.prepare(
				"INSERT INTO row_summaries (user_entry_id, summary, updated_at, source) VALUES (?, ?, ?, ?) ON CONFLICT(user_entry_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at, source = excluded.source",
			)
			.run(userEntryId, summary, new Date().toISOString(), source);
	}

	// Newest first. The newest row is left out: the main model writes its summary when it answers.
	rowsWithoutSummary(): { row: number; userEntryId: string }[] {
		return this.db
			.prepare("SELECT row, user_entry_id FROM rows WHERE summary IS NULL AND row < (SELECT MAX(row) FROM rows) ORDER BY row DESC")
			.all()
			.map((r) => ({ row: Number(r.row), userEntryId: String(r.user_entry_id) }));
	}

	// The first line of results from another session's database, so the reader knows which session it is.
	sessionLine(): string {
		const meta = new Map(this.db.prepare("SELECT key, value FROM meta").all().map((row) => [String(row.key), String(row.value)]));
		return `Session ${meta.get("session_id") ?? this.path} (cwd: ${meta.get("cwd") ?? "unknown"})`;
	}

	// One line for history_sessions.
	overview(current: boolean): string {
		const meta = new Map(this.db.prepare("SELECT key, value FROM meta").all().map((row) => [String(row.key), String(row.value)]));
		const last = this.db.prepare("SELECT MAX(timestamp) AS t FROM entries").get()?.t;
		const first = this.db.prepare("SELECT request FROM rows WHERE row = 1").get();
		const request = first ? oneLine(String(first.request ?? "")) : "";
		return [
			`${meta.get("session_id") ?? this.path}${current ? " (this session)" : ""}`,
			`cwd: ${meta.get("cwd") ?? "unknown"}`,
			`${this.rowCount()} rows`,
			`last: ${timeOf(last) || "unknown"}`,
			first ? `first request: "${request.length > firstRequestChars ? `${request.slice(0, firstRequestChars)}...` : request}"` : "no rows",
		].join(" | ");
	}

	rowCount(): number {
		return Number(this.db.prepare("SELECT COUNT(*) AS n FROM rows").get()!.n);
	}

	rowOf(userEntryId: string): number | undefined {
		const found = this.db.prepare("SELECT row FROM rows WHERE user_entry_id = ?").get(userEntryId);
		return found ? Number(found.row) : undefined;
	}

	// Page 1 holds the newest rows, so page contents move when a row is added. Row numbers do not move.
	page(p = 1): string {
		const count = this.rowCount();
		if (count === 0) return "The history has no rows yet.";
		const pages = Math.ceil(count / pageRows);
		if (!Number.isInteger(p) || p < 1 || p > pages) throw new Error(`Page ${p} does not exist. Pages: 1 (newest) to ${pages} (oldest).`);
		const hi = count - (p - 1) * pageRows;
		const lo = Math.max(1, hi - pageRows + 1);
		const rows = this.db
			.prepare(
				`SELECT r.row, r.timestamp, r.request, r.summary, length(e.text) - ${userPrefix.length} > ${requestChars} AS clipped
				FROM rows r JOIN entries e ON e.id = r.user_entry_id WHERE r.row BETWEEN ? AND ? ORDER BY r.row DESC`,
			)
			.all(lo, hi);
		const label = [...(p === 1 ? ["newest"] : []), ...(p === pages ? ["oldest"] : [])].join(" and ");
		const older = p < pages ? `Older rows: page ${p + 1}.` : "No older rows.";
		return [
			`Page ${p} of ${pages}${label ? ` (${label})` : ""}: rows #${hi} to #${lo}, newest first. ${older} Use ${openToolName} with a row number for its raw messages.`,
			...rows.map((row) =>
				[
					`#${row.row} (${timeOf(row.timestamp)})`,
					`Request: ${oneLine(String(row.request ?? ""))}${row.clipped ? "..." : ""}`,
					`Summary: ${row.summary ? oneLine(String(row.summary)) : "(no summary)"}`,
				].join("\n"),
			),
		].join("\n\n");
	}

	private rowMessages(row: number, toolResultMax?: number): string {
		const found = this.db.prepare("SELECT first_seq, last_seq FROM rows WHERE row = ?").get(row);
		if (!found) throw new Error(`Row #${row} does not exist. Rows: #1 to #${this.rowCount()}. Use ${pageToolName} to see them.`);
		const parse = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.parse(String(r.json)) as Entry);
		const edits = contextEdits(parse(this.db.prepare("SELECT json FROM branch WHERE type = 'context_edit'").all()));
		const entries = parse(this.db.prepare("SELECT json FROM branch WHERE seq BETWEEN ? AND ?").all(found.first_seq, found.last_seq));
		return entries
			.map((entry) => entryMessage(entry, edits))
			.map((message) => (message ? serializeMessage(message, toolResultMax) : ""))
			.filter(Boolean)
			.join("\n\n");
	}

	open(row: number, part = 1): string {
		const parts = paginate(this.rowMessages(row), partChars);
		if (!Number.isInteger(part) || part < 1 || part > parts.length) throw new Error(`#${row} has ${parts.length} parts.`);
		const more = part < parts.length ? ` Call ${openToolName} with part ${part + 1} for more.` : "";
		return `#${row} raw messages, part ${part} of ${parts.length}.${more}\n\n${parts[part - 1]}`;
	}

	// Input for a backfill summary: tool results cut to toolResultMax, the whole row cut in the middle to maxChars.
	rowText(row: number, toolResultMax: number, maxChars: number): string {
		return clipMiddle(this.rowMessages(row, toolResultMax), maxChars);
	}

	// For the eval's sql tool. Call readOnly first, so a query cannot change the database.
	query(sql: string): string {
		const rows = this.db.prepare(sql).all();
		const lines: string[] = [];
		let used = 0;
		for (const row of rows.slice(0, queryMaxRows)) {
			const line = JSON.stringify(row);
			if (lines.length > 0 && used + line.length > queryMaxChars) break;
			lines.push(line);
			used += line.length;
		}
		const rest = rows.length - lines.length;
		return [`${rows.length} rows.`, ...lines, ...(rest > 0 ? [`${rest} more rows are not shown. Use LIMIT, WHERE, or substr().`] : [])].join("\n");
	}

	readOnly() {
		this.db.exec("PRAGMA query_only = ON");
	}

	close() {
		this.db.close();
	}
}
