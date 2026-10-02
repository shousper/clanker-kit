---
name: github-work-summary
description: Generates a categorized work summary from GitHub activity (PRs authored, issues created, code committed) for a given time period and organization, using parallel subagents for fast detail fetching. Use when the user asks "what did I work on", "what did I do last week", wants a work log, weekly update, standup notes, sprint recap, accomplishments list, performance review input, or any summary of their contributions. DO NOT TRIGGER for repository changelogs, release notes, or team-wide activity reports.
---

# GitHub Work Summary

## Overview

Generates a comprehensive work summary from a user's GitHub activity (PRs, issues) for a specified time period and organization, using the `gh` CLI for data collection and parallel subagents for detail fetching.

## When to Use

- User asks "what did I do last week?" or similar
- User needs a weekly/monthly work summary or standup notes
- User wants to review contributions across an organization
- User needs to compile accomplishments for a performance review or report

**Not for:** Repository-level changelogs, release notes, or team-wide activity reports.

## Process

Copy this checklist and track progress:

```
Work Summary Progress:
- [ ] Step 1: Clarify parameters (period, org)
- [ ] Step 2: Run data collection script
- [ ] Step 3: Launch parallel subagents for detail fetching
- [ ] Step 4: Analyze contributions
- [ ] Step 5: Generate categorized summary
```

### Step 1: Clarify Parameters

Determine two inputs from your human partner's request:

| Parameter | Default | Examples |
|-----------|---------|---------|
| **Period** | "last week" | "this week", "last month", "last 14 days", "2026-01-01 to 2026-01-31" |
| **Organization** | Ask user | `"ethpandaops"`, `"*"` for all orgs |

If either is ambiguous, ask before proceeding.

### Step 2: Run Data Collection Script

Run the categorization script, where `<base>` is this skill's base directory:
```bash
python3 "<base>/scripts/collect_activity.py" "<period>" "<org>" "<today_date>"
```

The script outputs JSON with all matching PRs and issues. Capture this output for Step 3.

**If the script fails:** Verify `gh` CLI is installed and authenticated (`gh auth status`). The user must be logged in.

### Step 3: Fetch Details with Parallel Subagents

**CRITICAL**: Launch ALL detail-fetching agents in a SINGLE message using multiple parallel subagent-delegation calls for maximum speed.

For each PR in the JSON output, create one subagent:
```bash
gh pr view <number> --repo <owner/repo> --json body,comments,author,commits
```

For each issue, create one subagent:
```bash
gh issue view <number> --repo <owner/repo> --json body,comments,author
```

Wait for all agents to complete before proceeding.

### Step 4: Analyze Contributions

For each item, determine your human partner's actual contribution:

| Activity Type | Include? | What to Extract |
|--------------|----------|----------------|
| PR authored by user | Yes | PR description, what was built/fixed/changed |
| Issue authored by user | Yes | Issue description, what was reported/documented |
| PR with user's commits | Yes | Commit descriptions, code contributions |
| PR user only reviewed | **No** | Skip entirely |
| PR/issue user only commented on | **No** | Skip entirely |

Focus on what your human partner **did**, not what happened around them.

### Step 5: Generate Summary

Organize by theme, not chronologically. Use this structure:

```markdown
# Work Summary: <start_date> to <end_date>

## Major Initiatives
- [theme name]: Built/Implemented/Designed X (PR #123, #124)

## Feature Development
- Built [feature] for [purpose] (PR #N - merged/open)

## Bug Fixes
- Fixed [issue] that caused [impact] (PR #N - merged)

## Infrastructure / DevOps
- [entry]

## Open Work
- [in-progress items with current status]
```

**Writing style:**
- Active voice, first person: "Built X", "Fixed Y", "Refactored Z"
- Include PR/issue numbers as links
- Note status: merged, open, closed
- Group related PRs under a single initiative
- Highlight key technical outcomes

## Data Collection Script

The data collection script lives at `scripts/collect_activity.py` in this skill's directory.

## Date Calculation Reference

| Period | Meaning |
|--------|---------|
| "last week" | Previous completed Monday-Sunday (NOT last 7 days) |
| "this week" | Current Monday through today |
| "last month" | First through last day of previous month |
| "last N days" | N days ago through today |
| "YYYY-MM-DD to YYYY-MM-DD" | Explicit date range |

All dates use ISO 8601 format. Use `"*"` as org to include all organizations.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Searching by `--created` instead of `--updated` | Always use `--updated` to capture work on existing PRs |
| Including items where user only reviewed/commented | Only include items where user authored or committed code |
| Fetching details sequentially | Launch ALL subagents in a single message for parallel execution |
| Missing items due to low limit | Always use `--limit 1000` |
| Confusing "last week" with "last 7 days" | "Last week" = most recent completed Mon-Sun |
| Writing passive summaries ("PR was merged") | Write active, first-person: "Built X", "Fixed Y" |
