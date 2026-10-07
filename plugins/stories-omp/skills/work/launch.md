# Launching the story planner on OMP

The runner is `plan.workflow.mjs` in this skill's directory. Import it from one `eval` cell (`language: "js"`) and `await` its `run()`. The module binds the eval kernel's `agent`, `log`, and `phase` globals itself: pass it the args array and nothing else.

## Launch

1. Resolve the skill directory: in the `bash` tool run `realpath skill://work`. It prints the real path; `echo` prints the URI unchanged, because OMP resolves internal URIs only in path arguments. Use that path as `SKILL_BASE` below; the `skill://` form does not work inside `import()`.
2. Write the args to `local://stories/plan-RUN_SLUG.json` with the `write` tool: a JSON array with one entry per claimed story.

   ```json
   [
     {
       "id": "st-XXXX",
       "complexity": "routine",
       "worktree": "/absolute/path/to/.worktrees/st-XXXX",
       "storyBody": "the full story body, pasted — the planner must not re-read the board"
     }
   ]
   ```

3. Run this cell with `eval`, `language: "js"`, `timeout: 0`:

   ```js
   const { run } = await import("SKILL_BASE/plan.workflow.mjs");
   return await run(JSON.parse(await read("local://stories/plan-RUN_SLUG.json")));
   ```

Replace the following:

- `SKILL_BASE`: the path printed in step 1.
- `RUN_SLUG`: a short name for this launch, such as the first story id.

The cell must `await run(...)`; a promise still pending when the cell returns is orphaned. Never pass a host object: `run()` takes one argument.

## Result delivery

Run `omp config get eval.autoBackground.enabled` in `bash` once per session. When it is `true`, a planning cell that outlasts the foreground window returns `Backgrounded as job JOB_ID`, your turn ends, and the result is delivered to you when the job settles — end your turn and wait for it; never poll. When it is `false`, the cell holds your turn until every planner returns. Either way `run()` resolves to `{ status, planned, unimplementable, failed }` directly; there is no envelope to unwrap. A planner that fails or exceeds 30 minutes is cancelled and lands in `failed` — park that story; there is no relaunch-with-cache on this harness.

The delivered snapshot truncates long plans, so never copy `plan` or `batches` out of it. The runner writes every planned story to two files, and those are what you use:

- `local://stories/ST-ID.plan.md` — the plan. Resolve the path with `realpath local://stories/ST-ID.plan.md` in `bash` and pass it straight to `story update ST-ID --plan-file <path>`.
- `local://stories/ST-ID.plan.json` — `{ id, plan, batches }`. In the build-flow cell, load the batches from it: `JSON.parse(await read("local://stories/ST-ID.plan.json")).batches`.

Read the snapshot only for each story's `status` and, for `failed`, its `error`.

## Complexity → agent

| Complexity | Agent | Resolves through |
|---|---|---|
| routine | story-planner-routine | `modelRoles.plan`, then `default` |
| hard | story-planner-hard | `modelRoles.slow`, then `plan` |
| frontier | story-planner-frontier | `modelRoles.slow` only |

These are OMP's built-in roles, so a fresh install resolves every planner without setup; no planner ever falls through to the `task` worker tier. Change a tier for everyone with `/model` → Roles, or override one agent via `task.agentModelOverrides.<agent-name>` (also editable from `/agents`). Nothing in this session chooses, retries, or substitutes a planner agent. A `failed` entry whose error says no model resolved is a settings problem, not a story problem: park the story with that error verbatim so your human partner sees the override key to set.

## kit:build-flow on this harness

build-flow runs from an `eval` cell too (see its own `launch.md` under `skill://build-flow`). With `eval.autoBackground.enabled` on, its result auto-delivers as a job when the run settles; off, the cell holds your turn until done. Either way, launch it, end your turn if the cell backgrounds, and never poll.

## Review personas

Dispatch each persona template (`references/personas/…`, or a project persona from `.agents/shousper-stories/personas/`) with the `task` tool, passing file paths, and record the single `VERDICT:` line it returns with `story record`.
