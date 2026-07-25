import type { SearchHit } from "./search-entries";

export const formatRecallOutput = (
  entries: SearchHit[],
  query?: string,
  headerOverride?: string,
  /** Indices whose content should be emitted fully instead of a snippet. */
  expandSet?: Set<number>,
): string => {
  if (entries.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }

  const header = headerOverride
    ? `${headerOverride} for "${query}":`
    : query
      ? `Found ${entries.length} matches for "${query}":`
      : `Session history (${entries.length} entries):`;

  const lines = entries.map((e) => {
    const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
    // Expanded entries are emitted verbatim regardless of query/snippet.
    const expanded = expandSet?.has(e.index);
    const body = expanded ? e.summary : query && e.snippet ? e.snippet : e.summary;
    return `#${e.index} [${e.role}]${fileSuffix} ${body}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};
