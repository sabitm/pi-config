---
name: senate
description: Multi-agent planning. Chair plans first, subagent-1 and subagent-2 each plan independently on the same brief, chair merges. Use for senate mode, independent second opinions, or plan-then-subagents before implementation.
---

# Senate

Three voices, one plan. Code only after user approval.

## Roles

| Role | Who | Duty |
|------|-----|------|
| Chair | You | Research, draft first, identical brief, judge, merge, gate on approval |
| A/B | `subagent-1`, `subagent-2` | Full independent plans only. No code. No cross-talk |

## Rules

1. Chair plans **before** calling subagents.
2. Both get the **same** brief — no chair plan, no split hints.
3. Senators: plan only (`Do NOT write code`).
4. Merge with a judgment table; pick the better argument, not authorship.
5. **No code until the user approves** the merged plan (project AGENTS.md still applies).
6. New user task = new senate cycle.

## Flow

1. **Clarify** if the goal is fuzzy.
2. **Chair research + draft** (scope, seams, files, tests, risks, non-goals).
3. **Dispatch in parallel** (`agentScope: "user"`):

```
tasks: [
  { agent: "subagent-1", task: "<identical brief>" },
  { agent: "subagent-2", task: "<identical brief>" }
]
```

4. **Judge** — table: topic | sub-1 | sub-2 | chair pick | why  
   (agree / pick 1 / pick 2 / hybrid / chair override).
5. **Merge** into one plan; list defaults if user says "as written".
6. **Ask approval.** Implement only after yes; re-plan if implementation breaks a decision.

## Brief (identical to both)

```
Plan only for <REPO>. Do NOT write code. Research independently.

Task: <goal>
Constraints: <AGENTS.md + user rules>
Must-read: <paths>
Background (facts only, no preferred design): <neutral context>

Deliverable:
1. Scope (in/out)
2. Model/API changes
3. Layout + imports
4. Core seams/flows
5. UI (if any)
6. Ordered file list
7. Tests
8. Risks / questions
9. Non-goals

Be concrete (types, signatures, failure modes). Return only the plan.
```

## Output to user

```
# Senate: <title>

## Judgment
| Topic | Sub-1 | Sub-2 | Pick |
|-------|-------|-------|------|
| ...   | ...   | ...   | ...  |

## Merged plan
<full plan + defaults for "as written">

Approve, amend, or re-run narrower. No code until approved.
```

## Don't

- Subagents before chair draft
- Different briefs or leaking plans between senators
- Rubber-stamp merge or pre-approval "setup" code
- Endless re-runs without user direction
