import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	Key,
	SelectList,
	Text,
	fuzzyFilter,
	matchesKey,
	type EditorTheme,
	type SelectItem,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import { preview, type Snippet } from "./store";

// pi's setEditorText does not trigger a repaint. The picker resolves as a promise
// microtask after the last input-driven render, so callers must request a fresh
// render once they mutate the editor, or the new text stays invisible until the
// next keypress.
let pickerTui: { requestRender: () => void } | undefined;

export function requestRender(): void {
	pickerTui?.requestRender();
}

function listTheme(theme: { fg: (color: "accent" | "muted" | "dim" | "warning", text: string) => string }): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

function editorTheme(selectList: SelectListTheme): EditorTheme {
	return {
		borderColor: (str) => str,
		selectList,
	};
}

function isSelectListKey(data: string): boolean {
	return (
		matchesKey(data, Key.up) ||
		matchesKey(data, Key.down) ||
		matchesKey(data, Key.enter) ||
		matchesKey(data, Key.return) ||
		matchesKey(data, Key.escape) ||
		matchesKey(data, Key.esc) ||
		matchesKey(data, Key.ctrl("c"))
	);
}

export async function pickSnippet(
	ctx: ExtensionContext,
	mode: "insert" | "remove",
	snippets: Snippet[],
): Promise<Snippet | undefined> {
	if (snippets.length === 0) {
		return undefined;
	}

	const titleText = mode === "insert" ? "Insert snippet" : "Delete snippet";

	return ctx.ui.custom<Snippet | undefined>((tui, theme, _keybindings, done) => {
		pickerTui = tui;
		const container = new Container();
		const items: SelectItem[] = snippets.map((snippet, index) => ({
			value: String(index),
			label: preview(snippet.text),
			description: undefined,
		}));
		const themeForList = listTheme(theme);
		const editor = new Editor(tui, editorTheme(themeForList));
		editor.disableSubmit = true;

		const createList = (filtered: SelectItem[]) => {
			const next = new SelectList(filtered, 10, themeForList);
			next.onSelect = (item) => {
				done(snippets[Number(item.value)]);
			};
			next.onCancel = () => done(undefined);
			return next;
		};

		let list = createList(items);

		const replaceList = (filtered: SelectItem[]) => {
			// SelectList.setFilter is prefix-only, so rebuild on each query for fuzzy matching.
			container.removeChild(list);
			list = createList(filtered);
			container.addChild(list);
		};

		const applyFilter = (query: string) => {
			const filtered =
				query.length > 0 ? fuzzyFilter(items, query, (item) => item.label) : items;
			replaceList(filtered);
		};

		container.addChild(new Text(theme.fg("accent", titleText), 1, 0));
		container.addChild(editor);
		container.addChild(
			new Text(theme.fg("dim", "type to filter, up/down select, enter confirm, esc cancel"), 1, 0),
		);
		container.addChild(list);

		editor.onChange = (text) => {
			applyFilter(text);
			tui.requestRender();
		};

		return {
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
					done(undefined);
					return;
				}
				// Navigation/confirm stay on the list; printable and edit keys go to the search field.
				if (isSelectListKey(data)) {
					list.handleInput(data);
				} else {
					editor.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}
