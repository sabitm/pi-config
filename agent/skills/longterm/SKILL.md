---
name: longterm
description: >-
  Keep the agent aligned on long-horizon tasks that span many context compactions. State lives on disk in ignored/NNN-<task>/longterm/ (goal, plan, current step, decisions, failed attempts). A companion Pi extension reinjects it after compaction and session re-entry. Use when the user says "longterm", "long-horizon", "long-running task", "survive compaction", "resume the longterm task", or starts work expected to outlast several compactions. Also use when injected context says "longterm: context was compacted".
---

# Longterm

The conversation context is a cache. The files on disk are the source of truth.
A compaction summary is lossy. When the summary and the files disagree, the files win.

## Pi integration

The companion extension is `~/.pi/agent/extensions/longterm.ts`.
Run `/reload` after installing or changing the skill or extension.
Start Pi from the project root. The extension scans only `ignored/*/longterm/ACTIVE` under Pi's working directory.
It does not search parent directories or change Pi's default compaction.

- `session_before_compact` records the persistent Pi session path in `TRANSCRIPTS.md`.
- `session_compact` schedules task-state injection before the next model request, including automatic continuations.
- `session_start` schedules the same injection on startup, reload, new sessions, resume, and forks.
- The `context` handler injects a bounded snapshot of `GOAL.md` and `NOW.md` for one active task.
- With multiple active tasks, it lists their paths and objectives instead of choosing one.
- Each file snapshot includes at most 150 lines and 16 KiB. Read the file if the snapshot reports truncation.
- The snapshot stays in model context until another re-entry or the active-task markers change. It is not a separate transcript entry.

## Toggle

| Scope | Off | On |
|---|---|---|
| One task | Delete `ignored/NNN-<task>/longterm/ACTIVE` | Create that file |
| All longterm automation, all projects | `touch ~/.pi/agent/skills/longterm/DISABLED` | `rm -f ~/.pi/agent/skills/longterm/DISABLED` |

When the user says "longterm hooks off" or "longterm hooks on", run the matching global command.
The extension checks these files on each run. No restart is necessary.
Disabling automation does not remove context already sent to the model.

## Setup (once per task)

1. Choose the task directory under `ignored/` in the project root.
   - Existing task: use its `NNN-<task>/` directory.
   - New task: use the next free number, zero-padded to 3 digits (for example `010-<kebab-name>/`).
2. Present the setup plan and get explicit approval before creating files.
   Include the five task files, `ACTIVE`, and extension-managed `TRANSCRIPTS.md` inside this task's `longterm/` directory.
3. Create `ignored/NNN-<task>/longterm/`. Do not touch other files in `NNN-<task>/`.
4. Copy the five files from this skill's `templates/` directory into it.
5. Write `GOAL.md` with the user. Get explicit user approval of `GOAL.md`.
6. Write the first `PLAN.md` and `NOW.md`.
7. Record the approval as the first entry in `DECISIONS.md`.
   State the scope: "writes inside longterm/ for this task, including extension-managed transcript paths".
8. Create the empty marker file `longterm/ACTIVE` only after setup approval is recorded.

## Files

| File | Content | Write rule |
|---|---|---|
| `GOAL.md` | Objective, acceptance criteria, constraints, non-goals | Write once. Change only with user approval. |
| `PLAN.md` | Milestones with status, verification command per milestone, Parked list, Archive | Update at milestone boundaries. |
| `NOW.md` | Current step, exact next action, fast checks, blockers, open questions, approved scope | Overwrite often. Keep under 40 lines. |
| `DECISIONS.md` | Decisions and user approvals, with reason and rejected alternatives | Append only. |
| `ATTEMPTS.md` | Failed approaches and why they failed | Append only. |
| `TRANSCRIPTS.md` | Paths of full persistent Pi session files | Written by the companion extension before compaction. Do not edit. |
| `ACTIVE` | Empty marker | Present while the task is in progress. |

## Approvals

- The approval at setup covers all writes inside `longterm/` for this task, except later changes to `GOAL.md`.
  These approved task-state writes need no further plan.
- All other file changes still follow the user's normal plan-and-approve rule.
- Record every user approval in `DECISIONS.md` as an `approval` entry. Include the exact scope (files and changes).
- After a compaction, an approval is in effect only if `DECISIONS.md` records it. Do not trust the summary for approvals.
- Record the active approval id in `NOW.md` under "Approved scope".

## Working loop

1. **Write before you act.** Update `NOW.md` before each long or risky step. A compaction can occur during a step.
2. **Verify before "done".** A milestone is done only when its verification command passes. Record the command and result in `PLAN.md`.
3. **Record decisions immediately.** Append to `DECISIONS.md` when a decision is made. Include the rejected alternatives.
4. **Record failures immediately.** Append to `ATTEMPTS.md` when an approach fails. Include the cause and evidence.
5. **Check alignment at each milestone boundary.** Read `GOAL.md` again. Confirm that the next milestone serves an acceptance criterion.
   If it does not, stop and tell the user.
6. **Park side issues.** Add side issues to the Parked list in `PLAN.md`. Do not fix them unless the user asks.
7. **Do not reopen settled questions.** Before proposing an approach, search `DECISIONS.md` and `ATTEMPTS.md` for it.

## Re-entry protocol (after each compaction or resume)

The extension injects `GOAL.md` and `NOW.md` before the next model request. Then:

1. Read `PLAN.md` and the last entries of `DECISIONS.md` and `ATTEMPTS.md`.
2. Run the fast checks listed in `NOW.md` (for example `git status` and scoped tests).
3. Compare the results with `NOW.md`. If they disagree, trust the evidence. Then correct `NOW.md`.
4. If the files lack a needed detail (exact error text, user wording, a reason), search the paths in `TRANSCRIPTS.md`.
   Use scoped `rg` or `grep`. Do not read the transcripts in full.
5. Continue from "Next action" in `NOW.md`.

Pi session files are JSONL and keep raw history after compaction.
They can contain abandoned branches and context-edited messages. A search match is evidence, not current approval.
One session keeps one path across compactions. Forks and new sessions can add more paths.
Ephemeral sessions have no persistent transcript path, so the extension cannot record one.

If the extension lists multiple active tasks, use the summary and the user's request to identify your task.
If you are not certain, ask the user.
If no injected context is present and the user mentions a longterm task, find `ignored/*/longterm/ACTIVE` under the project root.
Read `GOAL.md` and `NOW.md`, then run this protocol manually.

## Goal changes

Never change `GOAL.md` on your own. If the goal looks wrong, incomplete, or impossible, stop and ask the user.
After the user approves a change, update `GOAL.md` and record the change in `DECISIONS.md`.

## Context hygiene

- Ask the user for permission before spawning any subagent. State the proposed delegation and wait for approval.
- After approval, delegate file-heavy exploration when useful. Keep only the conclusions in the main context.
- Tell each subagent: "You are a subagent. Do not run memo. Do not write files in longterm/."
- Also tell each subagent: "Do not run filesystem searches rooted at / or /home/sabit. Scope searches to specific project or task directories."
- The main agent owns task-state writes to `longterm/`. The extension writes only `TRANSCRIPTS.md`.
- Move completed milestones to the Archive section of `PLAN.md`. Keep only their verification results.

## Closing

1. Confirm that each acceptance criterion in `GOAL.md` has passing evidence.
2. Write the final status in `NOW.md`.
3. Delete `longterm/ACTIVE`.
4. Report the result to the user with the evidence.

## Boundary with OptMem

- `longterm/` files hold the state of one task. The agent writes them under the setup approval.
- OptMem holds long-lasting facts across tasks. Activate it only when the user requests it.
- Write to OptMem only when the user explicitly asks.
- Never copy task state into OptMem on your own.
