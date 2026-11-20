# Launching build-flow on Claude Code

Claude Code's launch mechanic for step 5 ("Launch one workflow per run segment") of the build-flow process. Workflows always run in the background — you're notified on completion. Match this shape exactly:

```
Workflow({
  scriptPath: "<base>/build.workflow.js",
  args: {
    worktree: "<absolute path to the current worktree>",
    startBatch: 0,
    maxFixRounds: 3,
    ledger: { decisions: [], conventions: [], deviations: [] },
    batches: [
      // Batch 0 — independent tasks; implemented sequentially, then reviewed together
      [
        { id: "T1", title: "Add rate-limit config",
          prompt: "Add a `rateLimit` field (requests-per-minute, default 60) to config/server.ts and validate it is a positive integer on load." },
        { id: "T2", title: "Add logging middleware",
          prompt: "Create middleware/logging.ts that logs method, path, and duration per request. Wire it in server.ts before the router." }
      ],
      // Batch 1 — depends on batch 0
      [
        { id: "T3", title: "Enforce rate limit",
          prompt: "In middleware/rateLimit.ts, reject requests over the configured rateLimit with HTTP 429, using the config field from T1." }
      ]
    ]
  }
})
```

- Every task carries its FULL `prompt` text — agents never re-read the plan. Never abbreviate or summarize a prompt to shrink the call.
- `args` may be this object **or** a valid JSON string of it — the runner normalizes either. There is no `run_in_background` param (it's already background); unknown params error out. The only launches that fail are a **truncated/malformed payload** or **zero batches**.
- If `scriptPath` rejects a bundled path, read the file and pass its contents as inline `script` instead.

## Handling the result

The completion payload (task notification, `TaskOutput`, or a saved output file) is a harness **envelope**: `{ summary, agentCount, logs, result, workflowProgress, totalTokens, totalToolCalls }`. The workflow's own return value — `{ status, results, ledger, findings, verification }` — lives at **`.result`**. Read `status`, `results`, `ledger`, `findings`, and `verification` from there on the FIRST extraction. There is no top-level `status`; a script that reads top-level keys gets undefineds and wastes a probe "discovering" `.result`.

When re-reading a completed run later — after a usage-limit interruption, in a resumed session, via `TaskOutput`, or from a saved output file — the same envelope applies: the runner's return is under `.result`, and the top level is harness metadata. Extract from `.result` on the first attempt.

A `blocked` whose `reason` starts `stage agent impl:T3 did not complete` means that agent was stopped in `/workflows` or hit an unrecoverable API error (the runtime resolves it to `null`; the runner never reads that as an empty result). Check the agent in `/workflows`, then relaunch as described next.

## Stopping and resuming

Background execution keeps this session live — watch progress via `/workflows` and interject anytime. To stop, `TaskStop` the workflow; relaunch with `resumeFromRunId` to resume from cached agent results (same session, and the SAME `args`: every prompt embeds the ledger, so a changed `ledger` or `startBatch` replays nothing — which is fine when `startBatch` skips those batches anyway). Small batches keep work-at-risk low.

## Stage → Agent

`build.workflow.js` names a kit agent per stage; each agent's frontmatter pins its model and effort:

| Stage | Agent (model, effort) |
|---|---|
| Implementation | kit-worker (Sonnet, high) |
| Spec review | kit-worker |
| Quality review | kit-worker (kit-arbiter, Opus xhigh, on the final batch — its cumulative diff review is the whole-run safety net) |
| Fix (staged) | kit-worker → kit-arbiter |
| Post-fix re-check (scoped to the findings) | kit-worker |
| Final verification (full suite + lint, once per run) | kit-verifier (Sonnet, low) |

## Additional warnings

- Pass `run_in_background` or other unknown `Workflow` params — it always runs in background and errors on unexpected parameters.
- Truncate, summarize, or abbreviate the batch payload — a cut-off JSON blob is the one thing that makes the runner block. (A whole object or a whole valid JSON string both parse fine; incompleteness is the enemy, not stringification.)
