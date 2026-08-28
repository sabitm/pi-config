---
name: chunked-impl
description: Implement a spec or plan as a reviewable stream of small chunks. Each chunk is one logical change; after applying it, open the changed file(s) in the user's running nvim (via a --server socket) jumped to the first change, explain the chunk, then pause for the user's go-ahead before continuing. Use when the user asks to "chunk", "chunked implementation", or wants to review code chunk-by-chunk as it is written.
---

# chunked-impl

Implement as small, self-contained chunks the user reviews in nvim as they land.
A chunk is **one logical change** — may span a few hunks/files, but must read as a
single reviewable story. Never dump the whole implementation at once.

## 0. Preflight

1. **Spec.** Require a concrete spec/plan; if absent, ask. Do not guess scope.
2. **nvim socket.** `$SOCK` = `$CHUNKED_IMPL_NVIM` if set, else `/tmp/nvim.sock`.
   Verify:
   ```
   test -S "$SOCK" && nvim --server "$SOCK" --remote-expr '1'
   ```
   If dead, STOP and tell the user to relaunch with `nvim --listen "$SOCK"`.
   Opening files for review is the whole point — do not proceed without it.

## 1. Decompose and agree

Present an ordered list of chunks (one-line title each) before touching code.
Order so each builds on the last and diffs read top-to-bottom; keep each chunk
reviewable in one sitting. Get the user's OK first.

## 2. Per-chunk loop

1. **Apply edits.** Follow global conventions: no clutter/meta files, comments only
   on non-obvious or assumption-bearing code, no emojis, functional output.
2. **Open changed file(s) in nvim**, cursor on the first changed line:
   ```
   nvim --server "$SOCK" --remote "$FILE"
   nvim --server "$SOCK" --remote-send '<C-\><C-n>:<LINE><CR>zz'
   ```
   - `<C-\><C-n>` forces normal mode so the jump is robust mid-insert; `zz` centers.
   - `<LINE>` = first changed line; `1` for new files.
   - Multi-file chunk: open each file, end focused on the primary file.
3. **Explain briefly**: what/why (1-2 sentences), files + key lines, any new
   assumption or invariant. The user is reading the code alongside — no walls of text.
4. **Pause.** Wait for go-ahead (`ok`/`next`) before the next chunk. On change
   requests: fix, re-open/re-jump, pause again. Never roll ahead on your own.

## 3. Wrap-up

One-line summary of what was implemented. No summary/report files.

## Notes

- `--remote-send` targets the currently focused buffer; if the user is mid-`:command`
  the jump may misfire harmlessly — re-send if needed.
- If the first change is ambiguous (e.g. pure deletion), jump to the nearest
  surviving line anchoring the change.
- Quote file paths with spaces in shell commands.
