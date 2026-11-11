# Decisions

Append only. Never edit an old entry. To change it, add a new entry that supersedes it.
Types: approval, decision, hypothesis, closure.

Format:
D<n> <YYYY-MM-DD> [type] <title>
- What: <the decision, the hypothesis, or the exact approved scope and limits>
- Basis: <E-ids, or "user request">
- Why: <short reason>
- Rejected: <alternatives and why they lost, or n/a>
- Supersedes: <D-ids and which part, or none>

D1 <YYYY-MM-DD> [approval] Longterm setup
- What: user approved GOAL.md and all writes inside longterm/ for this task, including automation-managed TRANSCRIPTS.md. Later GOAL.md changes need new approval.
- Basis: user request
- Why: setup of the longterm skill.
- Rejected: n/a
- Supersedes: none
