// Tool definitions shared by the extension and the eval.
import { Type } from "typebox";
import { openToolName, pageToolName, rowSummaryGuideline, rowSummaryToolName, summaryMaxChars } from "./render.ts";

export const rowSummaryTool = {
	name: rowSummaryToolName,
	label: "Row summary",
	description: `Save the summary of the current row (the current user request and the work done for it) in the history database. A second call replaces the first. At most ${summaryMaxChars} characters.`,
	promptSnippet: "Save the summary of the current user request in the history database",
	promptGuidelines: [rowSummaryGuideline],
	parameters: Type.Object({ summary: Type.String({ description: "The row summary." }) }),
};

export const pageTool = {
	name: pageToolName,
	label: "History page",
	description:
		"Show one page of row summaries from the history database, 20 rows per page. A row is one user request and the work done for it. Pages are numbered from the oldest: page 1 has the oldest rows, the last page has the newest. With no page, shows the newest page. Rows inside a page are oldest first.",
	promptSnippet: "Read row summaries from the history database, one page at a time",
	promptGuidelines: [
		`Use ${pageToolName} when you need earlier context that you cannot see, for example after a compaction. Call it with no page first for the newest page, then read lower page numbers.`,
	],
	parameters: Type.Object({
		page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number, where 1 is the oldest. Leave it out for the newest page." })),
	}),
};

export const openTool = {
	name: openToolName,
	label: "History open",
	description: "Show the raw messages of one row from the history database, in parts of 20,000 characters.",
	promptSnippet: "Read the raw messages of one row from the history database",
	promptGuidelines: [`Use ${openToolName} with a row number from ${pageToolName} when the row summary is not enough.`],
	parameters: Type.Object({
		row: Type.Integer({ minimum: 1, description: "Row number, for example 12 for #12." }),
		part: Type.Optional(Type.Integer({ minimum: 1, description: "Part number. Default 1." })),
	}),
};
