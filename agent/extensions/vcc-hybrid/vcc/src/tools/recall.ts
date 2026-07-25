import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAllMessages, subsetByEntryIds } from "../core/load-messages";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";
import { getActiveLineageEntryIds } from "../core/lineage";
import { normalizeRecallScope } from "../core/recall-scope";
import { offLineageHintFromLoaded } from "../core/off-lineage-hint";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Search session history. Defaults to active lineage; use scope:'all' to include off-lineage branches." +
      " Supports regex queries, paging, and expand indices.",
    promptSnippet:
      "vcc_recall: Search history; default scope is active lineage. Use scope:'all' for off-lineage branches.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance. Use \"double quotes\" for required contiguous phrase matches." }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" }),
      ),
      page: Type.Optional(
        Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1." }),
      ),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("lineage"),
          Type.Literal("all"),
        ], { description: "Search scope. Default: lineage; all includes off-lineage branches." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }

      const scope = normalizeRecallScope(params.scope);
      const lineageEntryIds = scope === "lineage"
        ? getActiveLineageEntryIds(ctx.sessionManager)
        : undefined;
      const expandSet = new Set(params.expand ?? []);
      const hasExpand = expandSet.size > 0;

      if (hasExpand && !params.query) {
        // Load full corpus once (full=true so expand renders verbatim), then
        // filter to the requested scope post-load. Same result as a scoped
        // load, without re-reading the file for the hint.
        const loaded = loadAllMessages(sessionFile, true, undefined);
        const scoped = subsetByEntryIds(loaded, lineageEntryIds);
        const fullMsgs = scoped.rendered;
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }],
            details: undefined,
          };
        }

        const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expanded);
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      // One unfiltered load (with fullIndices for expand). The lineage subset is
      // derived post-load via subsetByEntryIds, so lineage BM25 ranking is
      // identical to a scoped load, and the hint reuses the same load.
      const loaded = loadAllMessages(
        sessionFile,
        false,
        undefined,
        hasExpand ? expandSet : undefined,
      );
      const scoped = subsetByEntryIds(loaded, lineageEntryIds);
      const msgs = scoped.rendered;
      const scopedRaw = scoped.rawMessages;
      const allResults = params.query?.trim()
        ? searchEntries(msgs, scopedRaw, params.query)
        : msgs.slice(-DEFAULT_RECENT);

      if (params.query?.trim()) {
        const page = Math.max(1, params.page ?? 1);
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = allResults.slice(start, start + PAGE_SIZE);
        const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
        const scopeSuffix = scope === "all" ? " (scope: all)" : "";
        const header = totalPages > 1
          ? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
          : `${allResults.length} matches${scopeSuffix}`;
        const footer = page < totalPages
          ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
          : "";
        const crossBranch = scope === "lineage"
          ? offLineageHintFromLoaded(loaded.rendered, loaded.rawMessages, params.query, allResults.length)
          : "";
        let body = formatRecallOutput(pageResults, params.query, header, expandSet);

        // Expanded entries not on the current page: append their full verbatim
        // content so the caller recovers detail without paging. Soft-note any
        // requested expand indices absent from this scope (out-of-scope/missing).
        const onPage = new Set(pageResults.map((r) => r.index));
        if (hasExpand) {
          const byIndex = new Map(msgs.map((m) => [m.index, m]));
          const missing: number[] = [];
          const extra: typeof pageResults = [];
          for (const i of expandSet) {
            const m = byIndex.get(i);
            if (!m) { missing.push(i); continue; }
            if (!onPage.has(i)) extra.push(m);
          }
          const sections: string[] = [body];
          if (extra.length > 0) {
            sections.push(`--- Expanded (full) ---\n${formatRecallOutput(extra, undefined, undefined, expandSet)}`);
          }
          if (missing.length > 0) {
            sections.push(`--- Not in ${scope === "all" ? "session history" : "active lineage"}: ${missing.join(", ")} ---`);
          }
          body = sections.join("\n\n");
        }

        const output = body + footer + crossBranch;
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(allResults, params.query);
      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    },
  });
};

