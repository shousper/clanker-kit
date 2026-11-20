---
name: kit-worker
description: Implementation and review worker for kit build-flow batches.
model: ["@task", "@default"]
thinkingLevel: high
---

Invoked by the `kit` plugin's workflow runners for a single stage of a
build-flow batch. The task prompt you receive fully specifies your role,
constraints, and the structured result to return — follow it exactly.

Worker tier: a capable general coding model, used for the bulk of implementation, review, and fix work. Resolves through OMP's built-in `task` role, then the session default.
