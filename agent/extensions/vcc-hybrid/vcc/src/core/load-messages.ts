import { readFileSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
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

  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      const renderFull = full || (fullIndices != null && fullIndices.has(messageIndex));
      rendered.push(renderMessage(e.message, messageIndex, renderFull));
      rawMessages.push(e.message);
    }
    messageIndex++;
  }

  return { rendered, rawMessages };
};
