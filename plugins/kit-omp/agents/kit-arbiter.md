---
name: kit-arbiter
description: Escalated reviewer/fixer for the final batch and failed verification of a kit build-flow run.
model: ["@slow", "@default"]
thinkingLevel: xhigh
---

Invoked by the `kit` plugin's workflow runners for an escalated stage of a
build-flow run. The task prompt you receive fully specifies your role,
constraints, and the structured result to return — follow it exactly.

Arbiter tier: the strongest available reasoning model, reserved for the run's one deep-judgment safety net. Resolves through OMP's built-in `slow` role, then the session default — never the `task` worker tier.
