---
name: code-review
description: Orchestrates plan-alignment and quality review via a bundled review workflow that fans out review dimensions (correctness, quality, tests, security, architecture) and adversarially verifies each finding. Use when verifying implementation matches requirements or design/architectural alignment, before merging to main, after completing a major feature, before refactoring, after fixing a complex bug, or when a fresh perspective is needed. Consolidates findings into one report.
---

# Requesting Code Review

Run the bundled review workflow to fan out independent review dimensions over a diff, adversarially verify each finding, and consolidate the survivors — without any persistent team.

**Core principle:** Review early, review often. Verify findings before reporting them so false positives don't waste fix cycles.

## When to Request Review

**Mandatory:**
- Before merge to main
- After completing a major feature

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing a complex bug

## Two Modes

### Within build-flow

When work is being executed by kit:build-flow, the batch review gate inside the build-flow workflow already runs spec + quality review (with a staged fix-loop) at every batch boundary. Do **not** launch a separate review mid-build — pass the decisions ledger so reviewers have cross-batch awareness. Use a standalone review only for a final pre-merge pass.

### Standalone

When you want an independent review of a diff:

1. **Pick the diff ref.**
   - Uncommitted work (default): the workflow diffs against `main`.
   - Committed/PR range: pass `diffRef: "{BASE_SHA}..{HEAD_SHA}"`.
2. **Locate the workflow.** This skill is loaded with its base directory. The runner is the `review.workflow.*` file in that directory; `launch.md` names the exact file for your harness.
3. **Launch it.** Read `launch.md` in this skill's directory for your harness's exact launch mechanics, then extract the runner's return — `{ diffRef, findings }` — from the completion payload as described there.
4. **Act on the consolidated findings** (below).

The default dimensions are correctness, quality, tests, security, and architecture; override `reviewDims` to focus or extend the review. Quality, security, and architecture run on the arbiter tier (xhigh); correctness and tests run on the worker tier (high). Exact model pinning is per-platform — see `launch.md` in this skill's directory.

## Acting on Findings

- Fix Critical issues immediately.
- Fix Important issues before proceeding.
- Note Minor issues for later.
- Push back if a finding is wrong — with technical reasoning and code/tests that prove it. (The workflow already verifies findings adversarially, but it is not infallible.)

## Cross-Batch Awareness via the Ledger

Reviewers are ephemeral, so cross-task awareness comes from the **decisions ledger** the orchestrator maintains, not from a long-lived teammate's memory. Pass `ledger` in `args` so reviewers can spot inconsistencies with earlier batches ("Task 1 used X, Task 3 uses Y"), track cumulative coverage, and flag architectural drift.

## Red Flags

**Never:**
- Skip review because "it's simple".
- Ignore Critical issues.
- Proceed with unfixed Important issues.
- Argue with valid technical feedback.

**If a finding is wrong:**
- Push back with technical reasoning.
- Show code/tests that prove it works.

## Integration

- **kit:build-flow** — Its batch review gate covers in-flight batches; this skill handles standalone/pre-merge reviews.
- **Review rubric:** the `code-reviewer` agent — canonical review framework (plan alignment, code quality, architecture, documentation) — and `dispatch-template.md` in this skill's directory — context placeholders and output format that inform the workflow's dimension prompts.
- **Workflow:** the bundled fan-out-and-verify runner this skill launches; `launch.md` in this skill's directory names the file for your harness.

## Scope and Recommended Focus

This skill's unique value is **plan-alignment review** (verifying implementation matches requirements and design intent) and **workflow-based review orchestration** (fan-out dimensions + adversarial verification). General code quality review — style, linting, best practices, vulnerability scanning — should be deferred to the official `code-review` and `pr-review-toolkit` plugins, which provide multi-agent pipelines and specialist depth purpose-built for those concerns.
