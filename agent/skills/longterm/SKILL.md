---
name: longterm
description: >-
  Keep the agent aligned on long-horizon tasks that span many context compactions. State lives on disk in ignored/NNN-<task>/longterm/ (goal, plan, current state, evidence, decisions, failed attempts). Automation adds it to the conversation once after each compaction or session restore. Use when the user says "longterm", "long-horizon", "long-running task", "survive compaction", "resume the longterm task", or starts work expected to outlast several compactions. Also use when a message says "longterm: re-entry".
---

# Longterm

This skill is a structured handoff, not full memory. A file on disk is not in context until you read it.
Files preserve task state across compactions. Current evidence decides whether that state is still correct.
A compaction summary is lossy. Stored prose can also be wrong. When they disagree, check the evidence again.

## Automation

- After a compaction, and when a saved session is restored, automation adds one message that starts with "longterm: re-entry".
  It contains `GOAL.md` and `NOW.md` of the active task. Run the re-entry protocol once when it arrives.
- A new session gets no message. To continue a task there, run the re-entry protocol manually.
- Before each compaction, automation records the full conversation file path in `TRANSCRIPTS.md`.
- Automation looks only at `ignored/*/longterm/ACTIVE` under the directory where the session started.
- Automation blocks edits that remove or change existing text in `DECISIONS.md`, `EVIDENCE.md`, and `ATTEMPTS.md`.
  If an edit is blocked, add a new entry instead.

## Toggle

| Scope | Off | On |
|---|---|---|
| One task | Delete `ignored/NNN-<task>/longterm/ACTIVE` | Create that file |
| All automation, all projects | `touch <this skill's directory>/DISABLED` | `rm -f <this skill's directory>/DISABLED` |

When the user says "longterm hooks off" or "longterm hooks on", run the matching global command.
Automation checks these files on each run. No restart is necessary.
Disabling automation does not remove messages already in the conversation.

## Lifecycle

`NOW.md` has a `Status:` line with one of these values:

| Status | Meaning | `ACTIVE` |
|---|---|---|
| `active` | Implementation, analysis, or investigation is in progress. | Present |
| `waiting` | Work depends on user verification or an external result. Recovery stays on. | Present |
| `closed` | The user confirmed that the objective is finished or abandoned. | Removed |

- Finishing an approved action, experiment, or patch does not close the task.
  If you need the user's result, set `waiting` and fill in "Waiting for".
- Only the user closes a task. See Closing.
- If the user removed `ACTIVE` to pause a task, do not create it again unless the user asks.
- If you work on a task that has no `ACTIVE`, ask the user whether to resume it.

## Setup (once per task)

1. Choose the task directory under `ignored/` in the project root.
   - Existing task: use its `NNN-<task>/` directory.
   - New task: use the next free number, zero-padded to 3 digits (for example `010-<kebab-name>/`).
2. Draft the content of `GOAL.md` with the user in the conversation.
3. Get one explicit user approval of `GOAL.md` and of the setup scope, before you create any file.
   The scope is the six task files, `ACTIVE`, and the automation-managed `TRANSCRIPTS.md` in this task's `longterm/` directory.
4. Create `ignored/NNN-<task>/longterm/`. Do not touch other files in `NNN-<task>/`.
5. Copy the six files from this skill's `templates/` directory into it.
6. Write the approved `GOAL.md`, and the first `PLAN.md` and `NOW.md`.
7. Complete the D1 approval entry in `DECISIONS.md`.
8. Create the empty marker file `longterm/ACTIVE` only after D1 is recorded.

## Files

Write each fact once, in the file that owns it. Elsewhere, refer to its ID (`E<n>`, `D<n>`, `A<n>`, `M<n>`).

| File | Owns | Write rule |
|---|---|---|
| `GOAL.md` | Objective, acceptance criteria, constraints, non-goals | Write once. Change only with user approval. |
| `NOW.md` | Status, objective, milestone, active scope pointer, current step, latest verified result, next action, controlling constraints, blockers, fast checks | Overwrite. At most 1500 bytes. Readable without other files. |
| `PLAN.md` | Milestones, active approved scope, at most one proposed scope, Parked list, one-line Archive | Current instructions only. Update at milestone and scope changes. |
| `EVIDENCE.md` | Observations: what a command, capture, test, or user report shows, with source and limitation | Append only. |
| `DECISIONS.md` | Approvals, decisions, hypotheses, closure, with basis and supersession | Append only. |
| `ATTEMPTS.md` | Failed or inconclusive approaches, with evidence reference and retry condition | Append only. |
| `TRANSCRIPTS.md` | Paths of the full conversation files | Written by automation only. Do not edit. |
| `ACTIVE` | Empty marker | Present while status is `active` or `waiting`. |

- `NOW.md` is a handoff. A reader must understand it without opening other files. Write full sentences, and use IDs only as references.
  If the content does not fit the budget, remove content, not words. Do not write scripts to check its size.
- `PLAN.md` keeps the full text of each active approved scope in a section "Active scope, approved by D<n>".
  `NOW.md` "Active scope" names that section. It is a pointer, not a copy.
- When a scope is superseded or abandoned, or a proposal is rejected, remove its section from `PLAN.md`.
  Add one Archive line with the D-id. Do not keep old drafts outside the Archive.
- The Verify column of a done milestone records what verified it, with a date and E-id.
  Put constraints in `DECISIONS.md`, not in milestone text.
- An Archive entry in `PLAN.md` is one line of at most 200 characters, with an `E<n>` or `D<n>` reference.
- Subagents must not write files in `longterm/`. Tell each subagent this. The main agent owns all task-state writes.

## Evidence and inference

- An observation goes in `EVIDENCE.md`. It states only what the source shows.
- A limitation goes in the same `EVIDENCE.md` entry: missing controls, small samples, conditions not tested, or conflicting evidence.
- A hypothesis is a `[hypothesis]` entry in `DECISIONS.md`. Its `Basis:` lists the E-ids that support it.
- A decision states the action chosen under the recorded uncertainty.
- Do not claim a cause from a test window that has only successes or only failures.
- Before you compare two conditions, confirm that the test reproduces the condition that failed. Record any difference as a limitation.
- When an interpretation changes, keep the observation. Add a new entry with `Supersedes:`.

## Supersession

- Never edit an old entry in `DECISIONS.md`. Add a new entry with `Supersedes: D<n> (<which part>)`.
- `NOW.md` "Controlling constraints" lists at most 3 rules that limit the next action, in words, with their D-ids.
  Include used-up budgets. Leave out completed approvals and superseded entries.
- Other entries are history, not current rules. Search them only when a step needs them.

## Approvals

- The approval at setup (D1) covers all writes inside `longterm/` for this task, except later changes to `GOAL.md`.
  These writes need no further plan.
- All other file changes still follow the user's normal plan-and-approve rule.
- Record every user approval in `DECISIONS.md` as an `[approval]` entry. Include the exact scope and limits (files, changes, request budgets).
- Put an approval in `NOW.md` "Controlling constraints" only while it limits the next action (scope, remaining or used-up budget).
- If an approval request extends the work beyond `GOAL.md`, include a `GOAL.md` amendment in the same request.
  One approval then covers both, and `GOAL.md` stays current.
- After a compaction, an approval is in effect only if `DECISIONS.md` records it. Do not trust the summary for approvals.

## Working loop

1. **Write at meaningful boundaries.** Update `NOW.md` when the status, an approval or constraint, the active scope,
   the next action, or the latest verified result changes. Also update it before each long or risky step.
   Do not rewrite `NOW.md` when the existing handoff is still correct.
2. **Verify before "done".** A milestone is done only when its verification passes. Record the result in `EVIDENCE.md`. Refer to it from `PLAN.md`.
3. **Record what matters, when it happens.** Add observations to `EVIDENCE.md` and failures to `ATTEMPTS.md`.
   In `DECISIONS.md`, record approvals, changes of direction, changed interpretations, and closure.
   Do not record proposals that wait for approval, "step complete" notes, or procedural transitions.
   Keep each entry to at most 6 lines. Refer to unchanged constraints by D-id. Do not copy them.
4. **Check alignment at each milestone boundary.** Read `GOAL.md` again. Confirm that the next milestone serves an acceptance criterion.
   If it does not, stop and tell the user.
5. **Check progress before each experiment.** Before you propose an experiment, audit, or investigation step, answer:
   - What decision will this change, and why can we not make that decision with the evidence we have?
   - Is there a smaller step that addresses the user's objective now?
   If a smaller step exists, propose it first. An experiment must have a decision purpose.
6. **Park side issues.** Add side issues to the Parked list in `PLAN.md`. Do not fix them unless the user asks.
7. **Do not reopen settled questions.** Before you propose an approach, search `DECISIONS.md` and `ATTEMPTS.md` for it.

## Re-entry protocol

Run it once, only in these cases:
- A message starts with "longterm: re-entry".
- The user asks to continue a longterm task in a new session.

Do not run it on ordinary turns. You already see your own recent edits in the conversation.

1. Use `GOAL.md` and `NOW.md` from the message. If no message is present, find `ignored/*/longterm/ACTIVE` and read them.
2. Read the Milestones section of `PLAN.md` and the section named in `NOW.md` "Active scope". Do not read the Archive.
   Before you modify any file, read the full active scope. A milestone is an index, not the specification.
   For a question only, `NOW.md` is usually enough. To revise a design, also read the relevant decisions and evidence.
3. Read only the `DECISIONS.md` entries listed in "Controlling constraints". Search for them by ID.
4. Run the fast checks listed in `NOW.md`. They are cheap identity checks.
   Run tests only when the next action depends on their result.
   If the results disagree with `NOW.md`, trust the current evidence. Then correct `NOW.md`.
5. Search `EVIDENCE.md`, `ATTEMPTS.md`, the Archive, and `TRANSCRIPTS.md` paths only when a step needs a detail.
   Use scoped `rg` or `grep`. Do not read transcript files in full, because they are large.
6. Compare "Next action" with the latest user request. Recovery restores context. It does not replace the user's current request.
   - Continue the stored action only when it serves that request and is still approved.
   - If the request is a side task, finish it. Keep the longterm task as it is.
   - Ask the user only when the conflict is material and the context does not resolve it.

Transcript files keep raw history after compaction, including abandoned branches and edited messages.
A search match is evidence, not current approval. `TRANSCRIPTS.md` can list several paths, one per session.

If the message lists more than one active task, use the summary and the user's request to identify your task.
If you are not certain, ask the user.

## Goal changes

Never change `GOAL.md` on your own. If the goal looks wrong, incomplete, or impossible, stop and ask the user.
After the user approves a change, update `GOAL.md` and record the change in `DECISIONS.md`.

## Closing

1. Confirm that each acceptance criterion in `GOAL.md` has evidence in `EVIDENCE.md`.
2. Propose closing to the user. List each criterion with its E-ids, and any verification that is still pending.
3. Wait for the user to confirm. Do not close on your own judgment.
4. Record a `[closure]` entry in `DECISIONS.md`. Set `Status: closed` in `NOW.md`.
5. Delete `longterm/ACTIVE`.
