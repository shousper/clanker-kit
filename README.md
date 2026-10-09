# clanker-kit

A plugin marketplace for Claude Code and OMP hosting four plugins:

- **`kit`** (`plugins/kit-claude/`, `plugins/kit-omp/`) — a complete development workflow, from brainstorming ideas through design, implementation, code review, and branch completion.
- **`stories`** (`plugins/stories-claude/`, `plugins/stories-omp/`) — a story-based autonomous workflow built on kit: a repo-native markdown story board with typed verification gates and a goal loop that works the board until it is drained. Each plugin's README covers its harness; the shared guide is [shared/stories/README.md](shared/stories/README.md).
- **`writing`** (`plugins/writing-claude/`, `plugins/writing-omp/`) — an opt-in developer-documentation writing voice for every reply and file, a documentation-authoring skill, and an advisory Vale lint hook. Independent of kit.
- **`reports`** (`plugins/reports-omp/`, OMP only) — slash commands that report on your local omp history: token spend, skill usage, and words read and written. Independent of kit; see [its README](plugins/reports-omp/README.md).

The remainder of this README documents `kit`.

**Philosophy:** You control when work enters git history. Kit accumulates changes locally, lets you review holistically, and commits only when you say so. Planning documents stay out of version control. PRs are always created as drafts.

## Install

```bash
# Add the marketplace
/plugin marketplace add shousper/clanker-kit

# Install the core workflow plugin
/plugin install kit@shousper-kit

# Optional: story-based autonomous workflow (requires kit)
/plugin install stories@shousper-kit

# Optional: writing voice, documentation skill, and Vale lint (independent of kit)
/plugin install writing@shousper-kit
```

## Recommended Plugins

None are required, but these complement kit well:

| Plugin | Provides | Install |
|--------|----------|---------|
| [commit-commands](https://github.com/anthropics/claude-code-plugins) | `/commit` command for conventional commits | `commit-commands@claude-code-plugins` |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Persistent memory across sessions via automatic observation capture and semantic search | `claude-mem@thedotmack` |
| [pr-review-toolkit](https://github.com/anthropics/claude-code-plugins) | PR-focused review agents (silent failure hunting, type analysis, test coverage) | `pr-review-toolkit@claude-code-plugins` |
| [code-review](https://github.com/anthropics/claude-code-plugins) | General code quality review agent | `code-review@claude-code-plugins` |

Install with `/plugin marketplace add <repo>` then `/plugin install <name>@<marketplace>`.

## Workflow

Kit's default workflow chain:

```
brainstorming → writing-plans → build-flow → finish-branch
```

1. **Brainstorm** — Explore the idea, refine requirements, approve design
2. **Write plan** — Detailed implementation plan with TDD steps (no commit steps)
3. **Build flow** — A background workflow implements tasks in batches with review gates
4. **Finish branch** — Commit approved work, push, create draft PR

Each stage flows into the next automatically. You can enter at any point if you already have what the earlier stages produce.

## Skills (17)

### Core Workflow

| Skill | Description |
|---|---|
| `brainstorming` | Design exploration before implementation — creates worktree on approval |
| `writing-plans` | Create bite-sized implementation plans with TDD steps |
| `build-flow` | Execute a plan via a background workflow with batch-boundary reviews |
| `finish-branch` | Complete development — commit, push, create draft PR |

### Development Practices

| Skill | Description |
|---|---|
| `tdd` | Test-driven development — write failing test first, implement minimally |
| `debugging` | Systematic debugging before proposing fixes |
| `code-review` | Verify implementation meets requirements at review checkpoints |
| `consult-codex` | Get a second opinion from Codex on a design, diff, or bug |
| `receiving-review` | Handle code review feedback with technical rigor |
| `verify` | Run verification before claiming work is complete |

### Infrastructure

| Skill | Description |
|---|---|
| `git-worktrees` | Create isolated git workspaces with smart directory selection |
| `worktree-cleanup` | Clean up worktrees when done — user-triggered only |
| `create-pr` | Create pull requests — drafts by default, uses repo PR template |
| `parallel-agents` | Dispatch independent tasks to parallel subagents |
| `github-work-summary` | Generate GitHub activity summaries for standups or reports |

### Meta

| Skill | Description |
|---|---|
| `using-kit` | Skill discovery and usage patterns — loaded at session start |
| `writing-skills` | Create, edit, and test skills |

## Hooks

| Event | Hook | Trigger |
|-------|------|---------|
| PreToolUse | `standards-check.sh` | Edit/Write/MultiEdit — blocks an agent's first edit in Go, Rust, Python, C++, HCL, or Tailwind CSS until it has read that language's standards file; asks once per language per agent, and allows the edit if the check itself fails |
| PostToolUse | `standards-seen.sh` | Read — marks a language's standards as loaded when the agent reads its `CLAUDE.md` in full; a ranged read doesn't count |
| PostToolUse | `record.sh` | Write/Edit — records edited source paths (Go, Rust, JS/TS, HCL/Terraform/OpenTofu) to an agent-scoped scratch; never modifies files |
| Stop + SubagentStop | `format-on-stop.sh` | End of turn — formats the touched files and runs checks once, surfacing results as a single non-blocking message (advisory, not mid-turn blocking) |
| SessionStart | `session-start.sh` | Session startup, resume, clear, compact — kit intro |
| SessionStart | `hcl-detect.sh` | Startup/resume — one-time HCL tool-detection notice and scratch prune |
| SessionStart | `standards-reset.sh` | Clear/compact — forgets which standards were loaded, because the text has left the context |

On OMP, `plugins/kit-omp/omp/hooks.ts` runs the same checks from the `tool_call`, `tool_result`, and `session_compact` events.

## Agents

| Agent | Description |
|-------|-------------|
| `code-reviewer` | Reviews completed project steps against plans and coding standards |

## Code Standards

Kit bundles coding standards for these languages:

- **Go** — formatting, error handling, project structure
- **Rust** — clippy lints, formatting, idiomatic patterns
- **Python** — type hints, error handling, testing, and uv, ruff and mypy defaults; uses the project's own type checker when it has one
- **C++** — C++20 baseline, resource and memory safety, concurrency, security; `.h` and CMake files count as C++ only in a repository that holds C++ sources
- **HCL (Terraform/OpenTofu)** — file layout, naming, variables, outputs, version pinning, tooling
- **Tailwind CSS** — utility classes, component patterns; applies only in a project with a `tailwind.config.*` file or a `tailwindcss` dependency

A hook enforces them. The first time an agent edits a file in one of these languages, kit blocks the edit and tells the agent to read that language's standards file in full. The agent then retries. Kit asks once per language per agent, and a read with a line range doesn't count. Compaction resets the check, because the standards text leaves the context. Edits made through shell commands, such as `sed -i`, aren't checked.

## Tools

### claude-mem Backfill

`tools/claude-mem-backfill.mjs` — Backfills [claude-mem](https://github.com/thedotmack/claude-mem) with your historical Claude Code session logs. This is a workaround for claude-mem's currently broken import system.

**Requirements:** Node.js 18+, claude-mem installed and running. Zero external dependencies.

```bash
# List discoverable sessions
node tools/claude-mem-backfill.mjs --list

# Dry run — see what would be processed
node tools/claude-mem-backfill.mjs --dry-run

# Run backfill (5 concurrent by default)
node tools/claude-mem-backfill.mjs

# Only sessions after a date
node tools/claude-mem-backfill.mjs --after 2025-01-01

# Single session
node tools/claude-mem-backfill.mjs --session <uuid>
```

Resumable — tracks state in `~/.claude-mem/backfill-state.json`. Safe to interrupt with Ctrl+C and re-run.

## Releases

The plugins version and release independently. Tags follow the `<plugin>--vX.Y.Z` naming convention on `main`:

- **kit** — `plugins/kit-claude/.claude-plugin/plugin.json` (`kit-claude--vX.Y.Z`) and `plugins/kit-omp/.omp-plugin/plugin.json` (`kit-omp--vX.Y.Z`)
- **stories** — `plugins/stories-claude/.claude-plugin/plugin.json` (`stories-claude--vX.Y.Z`) and `plugins/stories-omp/.omp-plugin/plugin.json` (`stories-omp--vX.Y.Z`)
- **writing** — `plugins/writing-claude/.claude-plugin/plugin.json` and `plugins/writing-omp/.omp-plugin/plugin.json`
- **reports** — `plugins/reports-omp/.omp-plugin/plugin.json` (`reports-omp--vX.Y.Z`)

To release: bump the version in the plugin's manifest **and** its catalogue entry (`.claude-plugin/marketplace.json` for a Claude plugin, `.omp-plugin/marketplace.json` for an OMP plugin), merge, then tag the merge commit.

## Credits

- [superpowers](https://github.com/obra/superpowers) by Jesse Vincent — kit's skill framework is heavily inspired by superpowers. MIT licensed.
- [ethpandaops/ai-cookbook](https://github.com/ethpandaops/ai-cookbook) — code standards and hook patterns for Go, Rust, and Tailwind CSS.

## License

MIT

Note: The code standards bundled from ethpandaops/ai-cookbook currently have no upstream license; they are included with attribution.
