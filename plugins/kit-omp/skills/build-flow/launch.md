# Launching build-flow on OMP

The runner is `build.workflow.mjs` in this skill's directory. You import it from one `eval`
cell (`language: "js"`) and `await` its `run()`. The runner binds the eval kernel's `agent`,
`read`, `write`, `log`, and `phase` globals itself: you pass it the args object and nothing
else. Every stage agent it spawns is an ordinary subagent of your session, visible in the
Agents Hub, and its `phase()`/`log()` lines stream into the eval call.

## Launch

1. Resolve the skill directory: in the `bash` tool run `realpath skill://build-flow`. It prints
   the real path; `echo` prints the URI unchanged, because OMP resolves internal URIs only in
   path arguments. Use that path as `SKILL_BASE` below; the `skill://` form does not work
   inside `import()`.
2. Write the args to `local://build-flow/RUN_SLUG.json` with the `write` tool. The file form
   keeps the cell small and lets you resume by editing a file (`run()` also accepts the same
   object inline):

   ```json
   {
     "slug": "RUN_SLUG",
     "worktree": "/absolute/path/to/the/current/worktree",
     "startBatch": 0,
     "maxFixRounds": 3,
     "stageTimeoutMinutes": 60,
     "ledger": { "decisions": [], "conventions": [], "deviations": [] },
     "batches": [
       [
         { "id": "T1", "title": "Add rate-limit config",
           "prompt": "Add a `rateLimit` field (requests-per-minute, default 60) to config/server.ts and validate it is a positive integer on load." },
         { "id": "T2", "title": "Add logging middleware",
           "prompt": "Create middleware/logging.ts that logs method, path, and duration per request. Wire it in server.ts before the router." }
       ],
       [
         { "id": "T3", "title": "Enforce rate limit",
           "prompt": "In middleware/rateLimit.ts, reject requests over the configured rateLimit with HTTP 429, using the config field from T1." }
       ]
     ]
   }
   ```

3. Run this cell with `eval`, `language: "js"`, `timeout: 0`:

   ```js
   const { run } = await import("SKILL_BASE/build.workflow.mjs");
   return await run(JSON.parse(await read("local://build-flow/RUN_SLUG.json")));
   ```

Replace the following:

- `SKILL_BASE`: the path printed in step 1.
- `RUN_SLUG`: a short name for this run, such as `auth-system` (letters, digits, `.`, `_`, `-`).

Two rules, each of which has cost an hour when broken:

- The cell must `await run(...)`. A promise still pending when a cell returns is orphaned:
  it never resolves, in that cell or any later one, and the run looks busy forever.
- Never pass a host object. `run()` takes one argument; given `{ agent, ... }` first it
  returns `blocked` without spawning anything.

Every task carries its FULL `prompt` text; agents never re-read the plan, so never abbreviate
a prompt to shrink the file. The only launches that fail instantly are a malformed payload,
zero batches, a batch that is not a bare array, or a missing `agent()` global (the module ran
outside `eval`). All of those return `status: 'blocked'` with a reason; none return a fake
`done`.

## While it runs

Run `omp config get eval.autoBackground.enabled` in `bash` once before launching and tell your
human partner which case applies:

- `true`: the eval call returns after about 60 s with `Backgrounded as job JOB_ID`. Your turn
  ends and the result is delivered when the run settles. To block, use `hub` `wait` with
  `ids: [JOB_ID]` and a bounded `timeoutMs`; to stop, use `hub` `cancel`. A message typed to
  you backgrounds the cell earlier rather than aborting it.
- `false`: the eval call holds your turn for the whole run, 30 to 60 minutes for a typical
  plan. Your human partner watches and steers the stage agents in the Agents Hub (Alt+A).
  Aborting the eval call stops the run and cancels the in-flight agent.

Either way the stage agents are named `RUN_SLUG-` plus their stage: `RUN_SLUG-impl-T1`,
`RUN_SLUG-spec-b1`, `RUN_SLUG-quality-b1`, `RUN_SLUG-fix-b1-r1`, `RUN_SLUG-recheck-b1-r1`,
`RUN_SLUG-verify-r1`, `RUN_SLUG-verify-fix-r1` (bare stage names without a slug). The prefix
keeps a second run in the same session from colliding with the first — agent ids are
session-wide, and a reused id is uniquified (`impl-T1-2`) so `history://impl-T1` would name
the earlier run. `history://NAME` reads any transcript; a `blocked` reason quotes the exact id.

## Handling the result

`await run(...)` resolves to the runner's own `{ status, results, ledger, findings, verification }`.
There is no envelope to unwrap.

- `status === 'done'` → merge the returned `ledger`, report `verification.summary` as the test
  evidence (the workflow already ran the full suite + linter — do NOT re-run it or read test
  output yourself), present a final summary, then the iteration choice.
- `status === 'blocked'` → surface `reason`, `blockedAtBatch`, and any `findings`. A reason of
  the form `stage agent RUN_SLUG-impl-T3 did not complete: ...` means that agent failed, yielded
  off-schema, or exceeded `stageTimeoutMinutes` (in which case it was cancelled); read
  `history://RUN_SLUG-impl-T3` before deciding. Resolve with your human partner, then relaunch as
  described next.

## Stopping and resuming

The runner journals every finished stage to `local://build-flow/RUN_SLUG.state.json`. That
path lives inside the OMP session directory, so the journal is available in this session and
in a resume of it; a new session starts from scratch. Relaunching the same cell with the same
slug replays finished stages instantly and spawns only what remains:

- After a crash, a cancelled job, a provider error, an aborted cell, or a `blocked` return:
  relaunch the cell unchanged, with the original `startBatch` and the original `ledger`. Do
  not raise `startBatch` and do not paste the returned `ledger` into the args file: the journal
  already holds everything that finished. Batches before the blocked one replay in seconds,
  the blocked batch re-runs from the stage that failed (its later stages were dropped from the
  journal on return), and the verify phase re-runs. The runner rebuilds `results` and the
  ledger from the replayed stages, so nothing is recorded twice.
- If the blocker was a task problem, edit that task's `prompt` in the args file first; the
  blocked batch re-runs with the new text. To force one already-finished stage to re-run,
  delete its entry from the state file.
- `startBatch` and a pasted `ledger` are for resuming WITHOUT a journal: a new session, or a
  run launched without a slug. Set `startBatch` to `blockedAtBatch` and pass the returned
  `ledger`; batches before `startBatch` are skipped, not replayed, so their `results` are not
  reproduced and only the ledger carries their record.
- A run that ended `done` never replays; start a new run with a new slug.

## Stage → Agent

`build.workflow.mjs` selects a fixed OMP agent per stage. `agent()` on this harness takes no
per-call model or effort; the runner passes `{ agent, label, schema }`:

| Stage | Agent |
|---|---|
| Implementation | kit-worker |
| Spec review | kit-worker |
| Quality review | kit-worker (kit-arbiter on the final batch — its cumulative diff review is the whole-run safety net) |
| Fix (staged) | kit-worker → kit-arbiter |
| Post-fix re-check (scoped to the findings) | kit-worker |
| Final verification (full suite + lint, once per run) | kit-verifier |

Each agent resolves its model through OMP's built-in roles, which every install has populated:
`kit-worker` and `kit-verifier` through `task` (then `default`); `kit-arbiter` through `slow`
(then `default`). Change a tier for everyone with `/model` → Roles, or override one agent via
`task.agentModelOverrides.<agent-name>` (also editable from `/agents`). The plugin ships no
custom `modelRoles` keys, so nothing needs configuring before the first run.
