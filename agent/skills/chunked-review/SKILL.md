---
name: chunked-review
description: Review or learn from an existing commit or diff as a guided stream of small chunks. Each chunk is one logical change; for each chunk, open the file(s) in the user's running nvim (via a --server socket) jumped to the change, explain what changed, why it matters, and what to learn from it, then pause for the user's go-ahead before continuing. Use when the user asks to "chunked review", "review per chunk", "learn per chunk", "walk me through", or wants to understand a commit chunk-by-chunk.
---

# chunked-review

Review or learn from an existing diff in small, self-contained chunks the user reads in nvim as they land.
A chunk is **one logical change** — may span a few hunks/files, but must read as a
single reviewable story. Never dump the whole diff at once. This skill is read-only:
do not edit code unless the user explicitly asks.
Supports two goals with the same loop: review what changed, or learn how and why it works.

## 0. Preflight

1. **Diff source.** Resolve one source; if absent, ask. Do not guess scope.
   - Single commit: `git show SHA`
   - Range: `git diff A..B`
   - Working changes: `git diff` plus `git diff --cached`
   - Default: `HEAD`
2. **nvim socket.** `$SOCK` = `$CHUNKED_IMPL_NVIM` if set, else `/tmp/nvim.sock`.
   Verify:
   ```
   test -S "$SOCK" && nvim --server "$SOCK" --remote-expr '1'
   ```
   If dead, STOP and tell the user to relaunch with `nvim --listen "$SOCK"`.
   Opening files for review is the whole point — do not proceed without it.

## 1. Decompose and agree

Before reviewing, list the ordered chunks. Order chunks so each builds on the previous
one and diffs read top-to-bottom. State total chunk count, files per chunk, and key
lines. One approval authorizes the stated scope and first chunk. Each later chunk
requires `ok`/`next`.

## 2. Per-chunk loop

1. **Open file(s) in nvim**, cursor on the first changed line:
   ```
   nvim --server "$SOCK" --remote "$FILE"
   nvim --server "$SOCK" --remote-send '<C-\><C-n>:<LINE><CR>zz'
   ```
   - `<C-\><C-n>` forces normal mode so the jump is robust mid-insert; `zz` centers.
   - `<LINE>` = first changed line of the chunk; `1` for new files.
   - Multi-file chunk: open each file, end focused on the primary file.
2. **Explain briefly**: what/why (1-2 sentences), files + key lines, any new
   assumption or invariant, and what to learn from it. Name the concept
   and link it to prior chunks.
3. **Pause.** Wait for `ok`/`next` before the next chunk. If the user asks a
   question, answer briefly, re-open or re-jump if needed, then pause.

## 3. Wrap-up

List 3-5 key takeaways: what changed and reusable concepts to retain. No summary/report files.

## Notes

- `--remote-send` targets the currently focused buffer; if the user is mid-`:command`
  the jump may misfire harmlessly — re-send if needed.
- If the first change is ambiguous (e.g. pure deletion), jump to the nearest
  surviving line anchoring the change.
- Quote file paths with spaces in shell commands.
