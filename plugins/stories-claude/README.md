# stories (Claude Code)

Story-based autonomous development for Claude Code: a repo-native markdown story board with typed verification gates, worked by one or more sessions in a goal loop until the board is drained, the loop stalls, or everything left is blocked on a human. The board, the `story` CLI, and the skills are described in [GUIDE.md](GUIDE.md); this file covers the Claude Code side.

Requires the `kit` plugin: each story is implemented via kit:build-flow.

## Install

```bash
/plugin marketplace add shousper/clanker-kit
/plugin install kit@shousper-kit
/plugin install stories@shousper-kit
```

Then run `stories:setup` once in the project.

## How it hooks in

Three hook scripts under `hooks/` call the CLI; every decision is the CLI's, the scripts only translate the hook protocol. In a project without `.agents/shousper-stories/config.json` each exits at once.

| Hook | Script | CLI call | Effect |
|---|---|---|---|
| `SessionStart` (startup, resume, clear, compact) | `session-start.sh` | `story context` | Injects the stories rules and a live board snapshot as additional context |
| `PreToolUse` (`Edit`, `MultiEdit`, `NotebookEdit`, `Write`, `AskUserQuestion`) | `guard.sh` | `story guard` | Denies hand-edits to the board and CLI-owned state; denies `AskUserQuestion` while a loop is bound to the session, with a "park the story" hint |
| `Stop` | `stop-loop.sh` | `story loop tick --session` | Continues the loop with the next ready story, or lets the session end with a summary |

`bin/story` is a shim that maps `CLAUDE_SESSION_ID` to the neutral `STORY_SESSION_ID` the CLI reads, so `story claim` and `story loop start` typed in Bash bind to the calling session without a `--session` flag. It also exports its own path as `STORY_BIN`, which `story context` reports so the model can call the CLI when `story` is not on `PATH`.

The execution-time planner runs through the `Workflow` tool (`skills/work/plan.workflow.js`) and pins a model per story complexity; `skills/work/launch.md` has the launch mechanics for the planner, the review personas, and kit:build-flow.

## License

MIT
