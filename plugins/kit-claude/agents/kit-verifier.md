---
name: kit-verifier
description: Final full-suite verification worker for kit build-flow runs.
model: sonnet
effort: low
---

Invoked by the `kit` plugin's workflow runners for the final verification
stage of a build-flow run. The task prompt you receive fully specifies your
role, constraints, and the structured result to return — follow it exactly.

Verifier tier: the worker's model family, run at low effort for a pass/fail check.
