---
name: senate
description: User-invoked multi-agent deliberation for decisions, analysis, reviews, investigations, debugging, design, and planning. Use only when the user explicitly asks to summon or use the senate, requests senate mode, or invokes /skill:senate. Never invoke autonomously based on task complexity or perceived benefit.
---

# Senate

Three independent positions, one adjudicated result. Deliberation precedes execution.

## Activation

Run only when the user explicitly asks to summons the senate for the current task, including `/skill:senate`. Never infer permission from complexity, perceived benefit, or prior use; each new task requires a fresh summons.

## Roles

| Role | Duty |
|------|------|
| Chair | Clarify, research, draft independently, issue a neutral brief, adjudicate, synthesize |
| Senators | Analyze the same brief independently; expose evidence, assumptions, risks, and recommendations |

Use `subagent-1` and `subagent-2` as senators.

## Rules

1. Clarify ambiguous objectives, constraints, and expected output first.
2. Chair records an independent draft before dispatching senators.
3. Senators receive the same brief without the chair draft, preferred conclusions, or each other's work.
4. Deliberation is read-only: senators may inspect and discuss code, but must not modify state or cause external side effects.
5. Separate facts, assumptions, inferences, and recommendations.
6. Judge by correctness, evidence, coverage, feasibility, risk, simplicity, constraint compliance, and verifiability.
7. Synthesize on merit, not authorship. Preserve material dissent or uncertainty; do not force consensus.
8. Execution is a separate phase governed by user authorization and project rules. A new task starts a new senate cycle.

## Flow

1. Classify the task and define success criteria.
2. Chair researches and drafts an initial position.
3. Send both senators the identical neutral brief in parallel with `agentScope: "user"`.
4. Compare all positions topic by topic: consensus, Chair, Sub-1, Sub-2, hybrid, or unresolved.
5. Produce one cohesive result suited to the requested task.
6. If action would modify state, stop at the execution proposal unless already authorized.

If one senator fails, continue and disclose it. If both fail, return the chair result and state that independent review was unavailable.

## Senator brief

```text
Analyze this task independently. Do not modify files or cause external side effects.
Read-only research is allowed.

Task type: <decision | investigation | review | diagnosis | design | planning | other>
Objective: <desired outcome or question>
Success criteria: <what the result must establish>
Constraints: <user, project, policy, tool, and time constraints>
Must-read: <paths or sources>
Known facts: <neutral context without a preferred conclusion>
Required output: <task-specific deliverable>

Distinguish facts, assumptions, inferences, and recommendations. Include:
- findings and supporting evidence
- options or competing explanations
- recommendation and rationale
- risks, counterarguments, and uncertainty
- verification or next steps

Return only the independent analysis.
```

## Output

```markdown
# Senate: <title>

## Objective
<question, constraints, and success criteria>

## Judgment
| Topic | Chair | Sub-1 | Sub-2 | Resolution | Rationale |
|-------|-------|-------|-------|------------|-----------|
| ...   | ...   | ...   | ...   | ...        | ...       |

## Synthesized result
<decision, analysis, review, diagnosis, design, or plan>

## Dissent and uncertainty
<material disagreements, unknowns, and confidence limits>

## Next action
<verification, authorized execution, proposed execution, or none>
```

## Don't

- Dispatch senators before the chair draft
- Use different briefs or leak positions between participants
- Confuse confidence with evidence or majority with correctness
- Hide unresolved disagreement
- Perform side effects during deliberation
- Re-run without user direction or materially new evidence
