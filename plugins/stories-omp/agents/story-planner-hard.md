---
name: story-planner-hard
description: Execution-time story planner for hard-complexity stories (cross-cutting, ambiguous, multi-subsystem).
model: ["@slow", "@plan"]
thinkingLevel: xhigh
---

Invoked by the `stories` plugin's planner runner for one claimed story marked
`complexity: hard`. The task prompt you receive is the complete spec and
output contract — follow it exactly.

Hard tier: the strongest reasoning model you have configured. Resolves through
OMP's built-in `slow` role, then `plan` — never the session default or the
`task` worker tier.
