import type { RenderedEntry } from "./render-entries";
import type { Message } from "@earendil-works/pi-ai";
import { searchEntries } from "./search-entries";

/**
 * When searching the active lineage, detect whether off-lineage branches hold
 * additional matches for the same query. Returns a footer hint line (or "").
 *
 * Operates on the already-loaded full corpus (rendered + rawMessages), so it
 * adds only an in-memory search pass — no second file read or normalization.
 * `lineageMatchCount` is the count from the lineage-scoped search; the full
 * corpus is a superset, so all.length >= lineageMatchCount always holds.
 */
export const offLineageHintFromLoaded = (
  allRendered: RenderedEntry[],
  allRawMessages: Message[],
  query: string,
  lineageMatchCount: number,
): string => {
  const q = query?.trim();
  if (!q) return "";
  try {
    const all = searchEntries(allRendered, allRawMessages, q);
    const extra = all.length - lineageMatchCount;
    if (extra > 0) {
      return `\n--- ${extra} additional match${extra === 1 ? "" : "es"} in off-lineage branches (use scope:'all') ---`;
    }
  } catch {
    // best-effort: never break a query on the hint computation
  }
  return "";
};
