---
name: story-planner-frontier
description: Execution-time story planner for frontier-complexity stories, a human opt-in made at board approval.
model: ["@slow"]
thinkingLevel: xhigh
---

Invoked by the `stories` plugin's planner runner for one claimed story marked
`complexity: frontier`. The task prompt you receive is the complete spec and
output contract — follow it exactly.

Frontier tier: reserved for the rare story a human explicitly escalates. It
resolves through OMP's built-in `slow` role and nothing else.
