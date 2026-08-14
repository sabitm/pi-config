import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Snippet {
	text: string;
	createdAt: number;
}

function storePath(): string {
	return join(getAgentDir(), "snippets.json");
}

export async function loadSnippets(): Promise<Snippet[]> {
	let raw: string;
	try {
		raw = await readFile(storePath(), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		console.error(err);
		return [];
	}

	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			console.error("Invalid snippets.json: expected an array");
			return [];
		}
		return parsed as Snippet[];
	} catch (err) {
		console.error(err);
		return [];
	}
}

export async function saveSnippets(list: Snippet[]): Promise<void> {
	await writeFile(storePath(), JSON.stringify(list, null, 2));
}

export function preview(text: string, maxLen = 60): string {
	if (text.length === 0) {
		return "(empty)";
	}

	const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
	if (line === undefined) {
		return "(empty)";
	}

	const collapsed = line.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) {
		return "(empty)";
	}
	if (collapsed.length <= maxLen) {
		return collapsed;
	}
	return `${collapsed.slice(0, maxLen)}...`;
}
