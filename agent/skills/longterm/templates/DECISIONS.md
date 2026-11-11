# Decisions

Append only. Never edit an old entry. To change it, add a new entry that supersedes it.
Types: approval, decision, hypothesis, closure.
Record approvals, changes of direction, changed interpretations, and closure.
Do not record proposals that wait for approval, "step complete" notes, or procedural transitions.
At most 6 lines per entry. Refer to unchanged constraints by D-id. Do not copy them.

Format:
D<n> <YYYY-MM-DD> [type] <title>
- What: <the decision, the hypothesis, or the exact approved scope and limits>
- Basis: <E-ids, or "user request">
- Why: <short reason>
- Rejected: <optional: alternatives and why they lost>
- Supersedes: <D-ids and which part, or none>

D1 <YYYY-MM-DD> [approval] Longterm setup
- What: user approved GOAL.md and all writes inside longterm/ for this task, including automation-managed TRANSCRIPTS.md. Later GOAL.md changes need new approval.
- Basis: user request
- Why: setup of the longterm skill.
- Supersedes: none
