# Launching code-review on Claude Code

Claude Code's launch mechanic for step 3 ("Launch it") of the code-review process. The review workflow always runs in the background — you're notified on completion. Match this shape exactly:

```
Workflow({
  scriptPath: "<base>/review.workflow.js",
  args: { diffRef, reviewDims, ledger }
})
```

- If `scriptPath` rejects a bundled path, read the file and pass its contents as inline `script` instead.

## Model & Effort

`review.workflow.js` names a kit agent per dimension in its default `reviewDims`: correctness, quality, tests, and security run on `kit-worker` (Sonnet, high); architecture, the one deep-judgment safety net, runs on `kit-arbiter` (Opus, xhigh). Pass a custom `reviewDims` (`[{ key, focus, agent }, ...]`, with `agent` a scoped name such as `kit:kit-worker`) to change this.

## Handling the result

The completion payload (task notification, `TaskOutput`, or a saved output file) is a harness **envelope**: `{ summary, agentCount, logs, result, workflowProgress, totalTokens, totalToolCalls }`. The workflow's own return value lives at **`.result`**. Read it from there on the FIRST extraction. There is no top-level `findings`; a script that reads top-level keys gets undefineds and wastes a probe "discovering" `.result`.

`.result` is `{ status, diffRef, findings }`, plus `unverified` and `failed` when `status` is `partial`:

- `status === 'done'`: every dimension ran and every finding was adversarially verified. Act on `findings` directly: fix Critical issues immediately, fix Important issues before proceeding, note Minor issues for later.
- `status === 'partial'`: at least one reviewer or verifier did not complete (stopped in `/workflows`, or an unrecoverable API error). `failed` lists `{ id, error }` per agent by label (`review:security`, `verify:correctness:1`). `findings` are still verified. `unverified` lists findings whose verifier died: neither confirmed nor refuted, so say so when you report rather than dropping them. A failed `review:*` dimension is unreviewed.
