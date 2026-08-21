import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchExa } from "./src/mcp";

const parameters = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "A focused web search query",
	}),
});

interface WebSearchDetails {
	provider: "exa";
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
		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			if (!query) {
				throw new Error("Search query must not be empty");
			}

			const rawOutput = await searchExa(query, { signal });
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
					provider: "exa",
					query,
					truncated: truncation.truncated,
				} satisfies WebSearchDetails,
			};
		},
	});
}
