# reports (OMP)

Three slash commands that report on your local omp history: token spend, skill usage, and the words you read and write. The reports read files under `~/.omp` on your machine and send nothing anywhere.

## Install

Install the plugin from the repository marketplace, then restart omp:

```bash
omp plugin install reports@shousper-kit
```

All three reports are enabled by default. To keep only some, set the plugin's feature list:

```bash
omp plugin features reports-omp --set=words,spend
```

`--set` replaces the list. `--enable` adds to the stored list, which is empty right after install, so `--enable=words` on its own leaves only `words` enabled.

## Commands

| Command | Feature | Reports |
|---|---|---|
| `/reports:spend` | `spend` | Tokens and API-equivalent cost per model and provider, from `~/.omp/stats.db`. Runs `omp stats --summary` first to ingest new sessions; `--no-sync` skips that. |
| `/reports:skills` | `skills` | Skill loads per skill, source, project, and period; failed `skill://` reads; installed skills that were never loaded; and, with kit installed, whether agents read kit's code standards before their first edit in a language. |
| `/reports:words` | `words` | Words you typed and words shown to you, per period and project, in book-sized units. Tool calls and results, thinking, and subagent transcripts are counted for information only. |

Every command takes `[RANGE] [--sun|--mon]`, and `help` prints the full grammar. RANGE uses local time and defaults to `7d`:

| Form | Examples |
|---|---|
| Rolling, until now | `15m` `1h30m` `7d` `3mo` |
| Calendar period | `today` `yesterday` `wtd` `lw` `mtd` `lm` `ytd` `ly` `d-3` `mo-2` |
| Absolute | `2026` `2026-09` `2026-09-14` `2026-09-14T09:30` `09:30` |
| Range | `2026-09-01..2026-09-15` `mo-3..mo-1` `09:00..12:30` |

A single token covers its whole span: `2026-09` is all of September. A range `A..B` includes A and excludes B, so `2026-09-01..2026-09-15` covers 1 to 14 September and `mo-3..mo-1` covers the two months before last.

Weeks start on Monday. To start them on Sunday, pass `--sun` or set `SHOUSPER_REPORTS_WEEK_START=sun`.

## Run from a terminal

Each report also runs outside omp with Bun and prints the same tables:

```bash
bun ~/.omp/plugins/node_modules/reports-omp/extensions/words/report.ts lw
```

To get a short command, link the script onto your `PATH`, for example `ln -s ~/.omp/plugins/node_modules/reports-omp/extensions/words/report.ts ~/.local/bin/reports-words`.

## Limits

- The reports read the default profile's `~/.omp/agent/sessions` and `~/.omp/stats.db`. Named profiles and XDG data roots aren't supported.
- `/reports:words` can't tell text pasted inline from typing. Text pasted as an `<attachment>` block is left out of the typed count.
- `/reports:skills` builds the standards section from kit's standards gate. Without kit, the section doesn't appear.
