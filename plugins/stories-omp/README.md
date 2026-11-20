# stories (OMP)

Story-based autonomous development for OMP: a repo-native markdown story board with typed verification gates, worked by one or more sessions in a goal loop until the board is drained, the loop stalls, or everything left is blocked on a human. The board, the `story` CLI, and the skills are described in [GUIDE.md](GUIDE.md); this file covers the OMP side.

Requires the `kit` plugin: each story is implemented via kit:build-flow.

## Install

```bash
omp plugin install kit@shousper-kit
omp plugin install stories@shousper-kit
```

Then run `stories:setup` once in the project.

## How it hooks in

`omp/index.ts` registers an extension whose handlers spawn the CLI as a subprocess; every decision is the CLI's, the extension only translates events. In a project without `.agents/shousper-stories/config.json` each handler returns after one directory walk: no spawn, no message.

| Event | CLI call | Effect |
|---|---|---|
| `session_start`, `session_compact` | `story context` | Sends the stories rules and a live board snapshot for the next turn |
| `tool_call` on `bash` | — | Stamps `STORY_SESSION_ID` into the call's `env`, so `story claim` and `story loop start` bind to this session without a `--session` flag |
| `tool_call` on `write`, `edit`, `ask` | `story guard` | Blocks hand-edits to the board and CLI-owned state (every path an edit batch touches); blocks `ask` while a loop is bound to the session, with a "park the story" hint |
| `session_stop` | `story loop tick --session` | Continues the loop with the next ready story, or notifies the end-of-run summary |

`bin/` and `lib/` are the shared CLI; `bin/story` runs under the Node on your `PATH` (22.7 or newer).

The execution-time planner runs from an `eval` cell (`skills/work/plan.workflow.mjs`) and dispatches to one of three bundled agents by story complexity: `story-planner-routine`, `story-planner-hard`, `story-planner-frontier`. They resolve through OMP's built-in roles (`plan`, `slow`, `default`) rather than plugin-specific `modelRoles` keys, so a fresh install plans without configuration; the `task` worker tier is never a planner fallback. To change one planner's model, use `/agents`: it saves a per-agent override that stays in effect for future sessions until you clear it. On session start the extension resolves each planner agent's chain and reports any that cannot resolve. `skills/work/launch.md` has the launch mechanics for the planner, the review personas, and kit:build-flow.

## License

MIT
