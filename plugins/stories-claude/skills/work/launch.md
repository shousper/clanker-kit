# Launching the story planner on Claude Code

The runner is `plan.workflow.js` in this skill's directory; launch it with the Workflow tool. This skill's base directory is announced when the skill loads — use it as `<skill-base>` below.

## Launch

    Workflow({
      scriptPath: "<skill-base>/plan.workflow.js",
      args: [
        { id: "st-XXXX",
          complexity: "<from story show --json; absent = routine>",
          worktree: "<absolute path to .worktrees/st-XXXX>",
          storyBody: "<the full story body — paste it; the planner must not re-read the board>" }
      ]
    })

It runs in the background: launch it, then end your turn. The completion notification re-invokes you with the result envelope — read its `.result` for `{ status, planned, unimplementable, failed }`. Never call TaskOutput or otherwise poll a running workflow; your turn ending is the yield. A failed planner may be relaunched once with `resumeFromRunId` (successes are cached; only failures re-run).

## Tiers

`plan.workflow.js` names the planner agent per story complexity: routine → `story-planner-routine` (Sonnet, high), hard → `story-planner-hard` (Opus, xhigh), frontier → `story-planner-frontier` (Fable, xhigh). Every planner decision lives in that file; nothing in this session chooses, retries, or substitutes a planner.

## kit:build-flow on this harness

build-flow is also a background Workflow: launch it per its own `launch.md`, end your turn, and its completion notification re-invokes you with the result envelope. Never poll it (TaskOutput included).

## Review personas

Dispatch each persona template (`references/personas/…`, or a project persona from `.agents/shousper-stories/personas/`) with the Task tool, passing file paths, and record the single `VERDICT:` line it returns with `story record`.
