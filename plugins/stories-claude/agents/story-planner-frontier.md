---
name: story-planner-frontier
description: Execution-time story planner for frontier-complexity stories, a human opt-in made at board approval.
model: fable
effort: xhigh
---

Invoked by the `stories` plugin's planner runner for one claimed story marked
`complexity: frontier`. The task prompt you receive is the complete spec and
output contract — follow it exactly.

Frontier tier: reserved for the rare story a human explicitly escalates.
