// Tool definitions shared by the extension and the eval.
import { Type } from "typebox";
import { openToolName, pageToolName, rowSummaryGuideline, rowSummaryToolName, summaryMaxChars } from "./render.ts";

const sessionParameter = Type.Optional(
	Type.String({ description: "Session ID, a unique start of one, or a path to an opthist .sqlite file. Leave empty for this session." }),
);
const sessionGuideline = "Use session only when the user names another session or database.";

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
		"Show one page of row summaries from the history database, 20 rows per page, newest first. A row is one user request and the work done for it. Page 1 is the newest. Higher pages are older.",
	promptSnippet: "Read row summaries from the history database, one page at a time",
	promptGuidelines: [
		`Use ${pageToolName} when you need earlier context that you cannot see, for example after a compaction. Read page 1 first, then higher pages for older rows.`,
		sessionGuideline,
	],
	parameters: Type.Object({
		page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number. 1 is the newest. Higher pages are older. Default 1." })),
		session: sessionParameter,
	}),
};

export const openTool = {
	name: openToolName,
	label: "History open",
	description: "Show the raw messages of one row from the history database, in parts of 20,000 characters.",
	promptSnippet: "Read the raw messages of one row from the history database",
	promptGuidelines: [`Use ${openToolName} with a row number from ${pageToolName} when the row summary is not enough.`, sessionGuideline],
	parameters: Type.Object({
		row: Type.Integer({ minimum: 1, description: "Row number, for example 12 for #12." }),
		part: Type.Optional(Type.Integer({ minimum: 1, description: "Part number. Default 1." })),
		session: sessionParameter,
	}),
};
