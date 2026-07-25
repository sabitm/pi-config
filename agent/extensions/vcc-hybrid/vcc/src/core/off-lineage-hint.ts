import { loadAllMessages } from "./load-messages";
import { searchEntries } from "./search-entries";

/**
 * When searching the active lineage, detect whether off-lineage branches hold
 * additional matches for the same query. Returns a footer hint line (or "").
 * Only meaningful for scope === "lineage"; the full corpus is a superset of
 * the lineage corpus, so all.length >= lineageMatchCount always holds.
 */
export const offLineageHint = (
  sessionFile: string,
  query: string,
  lineageMatchCount: number,
): string => {
  const q = query?.trim();
  if (!q) return "";
  try {
    const { rendered, rawMessages } = loadAllMessages(sessionFile, false, undefined);
    const all = searchEntries(rendered, rawMessages, q);
    const extra = all.length - lineageMatchCount;
    if (extra > 0) {
      return `\n--- ${extra} additional match${extra === 1 ? "" : "es"} in off-lineage branches (use scope:'all') ---`;
    }
  } catch {
    // best-effort: never break a query on the hint computation
  }
  return "";
};
