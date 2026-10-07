# Launching code-review on OMP

The runner is `review.workflow.mjs` in this skill's directory. Import it from one `eval` cell
(`language: "js"`) and `await` its `run()`. The runner binds the eval kernel's `agent`, `log`,
and `phase` globals itself: pass it the args object and nothing else. Each reviewer is an
ordinary subagent of your session, visible in the Agents Hub.

## Launch

1. Resolve the skill directory: in the `bash` tool run `realpath skill://code-review`; use the
   printed path as `SKILL_BASE` below.
2. Run this cell with `eval`, `language: "js"`, `timeout: 0`:

   ```js
   const { run } = await import("SKILL_BASE/review.workflow.mjs");
   const result = await run({
     diffRef: "main",             // or "{BASE_SHA}..{HEAD_SHA}" for a committed/PR range
     slug: "RUN_SLUG",            // names this run's agents (RUN_SLUG-review-correctness, ...)
     ledger: { decisions: [], conventions: [], deviations: [] }, // optional cross-batch context
     // reviewDims: [{ key, focus, agent: "kit-worker" | "kit-arbiter" }, ...]
     //                           — optional; replaces the five default dimensions below.
     //                             `agent` is required per entry: an entry without it
     //                             spawns the session's default agent, not kit-worker.
     // stageTimeoutMinutes: 60   — optional; a reviewer still running after this is cancelled
   });
   await write("local://code-review/RUN_SLUG.json", JSON.stringify(result, null, 2));
   return result;
   ```

Replace `SKILL_BASE` with the path printed in step 1 and `RUN_SLUG` with a short name for this
review (letters, digits, `.`, `_`, `-`), unique within the session: `pre-merge`, `delta-2`.

- The cell must `await run(...)`: a promise still pending when the cell returns never resolves.
- Never pass a host object; `run()` takes one argument and returns `blocked` if it receives
  `{ agent, ... }` first.
- `diffRef` defaults to `'main'` if omitted. Anything after the ref is passed to `git diff`
  verbatim, so `"main -- src/auth"` scopes the review to a path.
- Agent ids are session-wide. Without `slug`, a second review in the same session reuses the
  bare labels, the runtime uniquifies them (`review-correctness-2`), and
  `history://review-correctness` then reaches the FIRST run's transcript. Pass a fresh `slug`
  per review, and read ids from the returned `agents` map rather than reconstructing them.
- Keep the `write(...)` line. A backgrounded cell's return value is delivered once and is not
  retrievable afterwards through `output()`; the file is what you reread later.
- A review takes a few minutes. With `eval.autoBackground.enabled: true` the call returns as a
  background job after about 60 s and the result is delivered when it settles (`hub` `wait`
  with its job id to block, `hub` `cancel` to stop); otherwise the call holds your turn.

## Handling the result

`await run(...)` resolves to `{ status, diffRef, findings, agents }`. `agents` maps each stage
label to the agent id actually spawned (`history://ID` reads its transcript).

- `status === 'done'`: every dimension ran and every finding was adversarially verified. Act on
  `findings` directly: fix Critical issues immediately, fix Important issues before proceeding,
  note Minor issues for later.
- `status === 'partial'`: at least one reviewer or verifier did not complete; `failed` lists
  `{ id, error }` per agent (`history://ID` has the transcript). The findings returned are
  still verified, but the failed dimension is unreviewed. Say so when you report.
- `status === 'blocked'`: the runner never started; `reason` says why (host object passed, or
  no `agent()` global because the module ran outside `eval`).

## Dimension → Agent

The default dimensions are correctness, quality, tests, security, and architecture; pass
`reviewDims` to focus or extend the review. Each dimension names its own OMP agent
(`kit-worker` by default; `kit-arbiter` for architecture, the one deep-judgment safety net).
Reviewer agents are named `review-DIMENSION`, verifiers `verify-DIMENSION-N`. Each agent
resolves its model through OMP's built-in roles, the same way build-flow does: `kit-worker`
through `task`, `kit-arbiter` through `slow`. Change a tier with `/model` → Roles, or override
one agent via `task.agentModelOverrides.<agent-name>`.
