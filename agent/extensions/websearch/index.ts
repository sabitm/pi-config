import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	searchExa,
	searchParallel,
	selectWebSearchProvider,
	webSearchModelName,
	type WebSearchProvider,
} from "./src/mcp";

const parameters = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "A focused web search query",
	}),
});

interface WebSearchDetails {
	provider: WebSearchProvider;
	query: string;
	truncated: boolean;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "websearch",
		description: "Search the public web for current information.",
		promptSnippet: "Search the public web for current information",
		promptGuidelines: [
			"Use websearch for current facts, recent events, or information that may have changed.",
			"Use websearch when source verification or up-to-date web information matters instead of guessing.",
		],
		parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const query = params.query.trim();
			if (!query) {
				throw new Error("Search query must not be empty");
			}

			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const modelName = webSearchModelName((ctx as unknown as { model?: unknown })?.model);
			const primary = selectWebSearchProvider(sessionId);
			const fallback: WebSearchProvider = primary === "exa" ? "parallel" : "exa";

			let rawOutput: string;
			let usedProvider: WebSearchProvider;

			const callProvider = (provider: WebSearchProvider) => {
				if (provider === "exa") return searchExa(query, { signal });
				return searchParallel(query, { signal, sessionId, modelName });
			};

			try {
				rawOutput = await callProvider(primary);
				usedProvider = primary;
			} catch (primaryError) {
				// Don't fallback on user abort.
				if (signal?.aborted) throw primaryError;
				const msg = primaryError instanceof Error ? primaryError.message : String(primaryError);
				if (/aborted/i.test(msg) && signal?.aborted) throw primaryError;
				try {
					rawOutput = await callProvider(fallback);
					usedProvider = fallback;
				} catch {
					throw primaryError;
				}
			}
			const truncation = truncateHead(rawOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const text = truncation.truncated
				? [
						truncation.content,
						`[Search output truncated at ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines.]`,
				  ]
						.filter(Boolean)
						.join("\n\n")
				: truncation.content;

			return {
				content: [{ type: "text", text }],
				details: {
					provider: usedProvider,
					query,
					truncated: truncation.truncated,
				} satisfies WebSearchDetails,
			};
		},
	});
}
