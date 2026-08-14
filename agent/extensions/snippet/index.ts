import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickSnippet, requestRender } from "./picker";
import { loadSnippets, preview, saveSnippets } from "./store";

async function saveCurrent(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const text = ctx.ui.getEditorText().trim();
	if (!text) {
		ctx.ui.notify("Nothing to save", "warning");
		return;
	}

	const list = await loadSnippets();
	if (list.some((snippet) => snippet.text === text)) {
		ctx.ui.notify("Snippet already saved", "warning");
		return;
	}

	list.push({ text, createdAt: Date.now() });
	await saveSnippets(list);
	ctx.ui.notify(`Snippet saved (${list.length} total)`, "info");
}

async function insertSnippet(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const snippets = await loadSnippets();
	if (snippets.length === 0) {
		ctx.ui.notify("No snippets saved yet", "warning");
		return;
	}

	const chosen = await pickSnippet(ctx, "insert", snippets);
	if (!chosen) {
		return;
	}

	const current = ctx.ui.getEditorText();
	if (current.trim() === "") {
		ctx.ui.setEditorText(chosen.text);
	} else {
		ctx.ui.setEditorText(`${current}\n${chosen.text}`);
	}
	requestRender();
}

async function removeSnippet(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const snippets = await loadSnippets();
	if (snippets.length === 0) {
		ctx.ui.notify("No snippets saved yet", "warning");
		return;
	}

	const chosen = await pickSnippet(ctx, "remove", snippets);
	if (!chosen) {
		return;
	}

	const ok = await ctx.ui.confirm("Delete snippet?", preview(chosen.text));
	if (!ok) {
		return;
	}

	const latest = await loadSnippets();
	await saveSnippets(latest.filter((snippet) => snippet.text !== chosen.text));
	ctx.ui.notify("Snippet removed", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("alt+n", {
		description: "Save editor text as snippet",
		handler: saveCurrent,
	});

	pi.registerShortcut("alt+i", {
		description: "Insert a snippet into the editor",
		handler: insertSnippet,
	});

	pi.registerCommand("snippet", {
		description: "Insert, save, or remove prompt snippets",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "") {
				await insertSnippet(ctx);
				return;
			}
			if (trimmed === "save") {
				await saveCurrent(ctx);
				return;
			}
			if (trimmed === "remove") {
				await removeSnippet(ctx);
				return;
			}
			ctx.ui.notify("Usage: /snippet [save|remove]", "warning");
		},
	});
}
