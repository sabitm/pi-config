import { readFileSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  /** Session entry id parallel to rendered/rawMessages (for post-load lineage filtering). */
  entryIds: (string | undefined)[];
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
  /** When set, render these entry indices fully (verbatim) regardless of `full`. */
  fullIndices?: Set<number>,
): LoadedMessages => {
  const content = readFileSync(sessionFile, "utf-8");
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: (string | undefined)[] = [];

  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      const renderFull = full || (fullIndices != null && fullIndices.has(messageIndex));
      rendered.push(renderMessage(e.message, messageIndex, renderFull));
      rawMessages.push(e.message);
      entryIds.push(typeof e.id === "string" ? e.id : undefined);
    }
    messageIndex++;
  }

  return { rendered, rawMessages, entryIds };
};

/**
 * Pure post-load filter: select loaded entries whose session id is in `ids`.
 * Returns a LoadedMessages subset (entryIds carried through). When `ids` is
 * undefined, returns the input unchanged. messageIndex is assigned at load
 * time and preserved here, so a filtered subset is byte-identical to loading
 * with the same id filter — but computed from one load instead of two.
 */
export const subsetByEntryIds = (
  loaded: LoadedMessages,
  ids?: Set<string>,
): LoadedMessages => {
  if (!ids) return loaded;
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: (string | undefined)[] = [];
  for (let i = 0; i < loaded.rendered.length; i++) {
    const id = loaded.entryIds[i];
    if (id && ids.has(id)) {
      rendered.push(loaded.rendered[i]);
      rawMessages.push(loaded.rawMessages[i]);
      entryIds.push(id);
    }
  }
  return { rendered, rawMessages, entryIds };
};
