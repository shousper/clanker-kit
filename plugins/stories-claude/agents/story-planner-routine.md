---
name: story-planner-routine
description: Execution-time story planner for routine-complexity stories.
model: sonnet
effort: high
---

Invoked by the `stories` plugin's planner runner for one claimed story. The
task prompt you receive is the complete spec and output contract — follow it
exactly: explore the story worktree, verify every file pointer, and return
either a plan with batches or an unimplementable question.

Routine tier: a capable planning model.
