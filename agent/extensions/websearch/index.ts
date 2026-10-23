import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildSearchOutput,
	searchExa,
	searchFirecrawl,
	searchParallel,
	searchTavily,
	searchTinyfish,
	searchWithFallback,
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

function callProvider(
	provider: WebSearchProvider,
	query: string,
	signal?: AbortSignal,
): Promise<string> {
	const options = { signal };
	switch (provider) {
		case "exa":
			return searchExa(query, options);
		case "parallel":
			return searchParallel(query, options);
		case "firecrawl":
			return searchFirecrawl(query, options);
		case "tavily":
			return searchTavily(query, options);
		case "tinyfish":
			return searchTinyfish(query, options);
	}
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
			const { provider, output } = await searchWithFallback(
				query,
				sessionId,
				(selected) => callProvider(selected, query, signal),
				signal,
			);

			const { text, truncated } = buildSearchOutput(output, truncateHead, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
				sizeLabel: formatSize(DEFAULT_MAX_BYTES),
			});

			return {
				content: [{ type: "text", text }],
				details: {
					provider,
					query,
					truncated,
				} satisfies WebSearchDetails,
			};
		},
	});
}
