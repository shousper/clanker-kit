---
name: story-planner-routine
description: Execution-time story planner for routine-complexity stories.
model: ["@plan", "@default"]
thinkingLevel: high
---

Invoked by the `stories` plugin's planner runner for one claimed story. The
task prompt you receive is the complete spec and output contract — follow it
exactly: explore the story worktree, verify every file pointer, and return
either a plan with batches or an unimplementable question.

Routine tier: a capable planning model. Resolves through OMP's built-in `plan`
role, then the session default — never the `task` worker tier, which follows
plans rather than writing them.
