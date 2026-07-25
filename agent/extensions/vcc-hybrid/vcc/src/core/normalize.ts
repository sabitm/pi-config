import type { Message } from "@earendil-works/pi-ai";
import type { NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

const normalizeOne = (msg: Message, msgIndex: number): NormalizedBlock[] => {
  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  // pi-ai's Message union no longer includes a "bashExecution" role, so the
  // literal comparison is widened to string to stay typeable. The branch is
  // defensive: command/output/exitCode are accessed as any since they are not
  // part of the current Message union (legacy/runtime-only shape).
  if ((msg as { role: string }).role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const exit = (msg as any).exitCode;
    return [{ kind: "bash", command: cmd, output: out, exitCode: exit, sourceIndex: msgIndex }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      name: msg.toolName,
      text: sanitize(textOf(msg.content)),
      sourceIndex: msgIndex,
    }];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex: msgIndex }];
    }

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
          sourceIndex: msgIndex,
        });
      }
    }
    return blocks;
  }

  return [];
};

export const normalize = (messages: Message[]): NormalizedBlock[] =>
  messages.flatMap((msg, i) => normalizeOne(msg, i));


