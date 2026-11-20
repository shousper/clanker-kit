export const meta = {
  name: 'build-flow-batch-runner-omp',
  description: 'Executes an implementation plan batch-by-batch (implement sequentially, then parallel spec+quality review with a staged fix-loop and scoped re-checks), ending with a full-suite verification. Returns done or blocked; never commits, never throws, never hangs: every stage is bounded by a timeout and journaled for resume. OMP-native: stage agents (kit-worker, kit-arbiter, kit-verifier) are selected inline.',
  phases: [
    { title: 'Implement' },
    { title: 'Review' },
    { title: 'Fix' },
    { title: 'Verify' },
  ],
}

// Host bridges. The OMP eval kernel installs agent/read/write/log/phase as globals of its
// worker VM, and a dynamically imported module sees them, so run() binds them itself: the
// launching cell passes the args object and nothing else. The optional second parameter
// overrides individual bridges (tests use it; a launch never should).
//
// agent(prompt, { agent, label, schema }) returns a handle immediately; the result comes
// from `await handle.wait({ timeout })` (timeout in SECONDS, inside an options object — a
// bare number is silently ignored), and a failed, off-schema, or cancelled agent makes
// wait() reject. There is no parallel(): concurrency is Promise.all over stages.

// args: {
//   slug: string,                // run name; journal at local://build-flow/<slug>.state.json (no slug = no journal)
//   batches: [ [ { id, title, prompt }, ... ], ... ], // dependency-ordered; tasks within a batch are independent
//   ledger: { decisions: string[], conventions: string[], deviations: string[] },
//   startBatch: number,          // resume point after a blocker (default 0)
//   maxFixRounds: number,        // default 3
//   stageTimeoutMinutes: number, // default 60; a stage still running after this is cancelled and the run blocks
//   worktree: string,            // absolute worktree path; stamped into every agent prompt
// }

// Stage -> OMP agent. kit-worker carries the default implement/spec/quality/fix/recheck
// load; kit-arbiter is the escalation tier (final-batch quality review, whose diff covers
// the whole run, plus last-round/final-verification fixes); kit-verifier is the dedicated
// full-suite verification agent.
const WORKER = 'kit-worker'
const ARBITER = 'kit-arbiter'
const VERIFIER = 'kit-verifier'

const emptyLedger = () => ({ decisions: [], conventions: [], deviations: [] })
// A provider that refuses work (rate limit, overload, exhausted quota) is not fixed by a
// relaunch or a different agent: which models to use is the user's call.
const PROVIDER_REFUSAL = /\b(429|529)\b|rate.?limit|overloaded|quota|usage limit/i
const REFUSAL_ADVICE = 'The model provider refused the request. Report this to the user and wait for direction.'

const errorText = (e) => (e && e.message ? e.message : String(e))

function bindHost(override) {
  const pick = (name) => (override && override[name] !== undefined ? override[name] : globalThis[name])
  return {
    agent: pick('agent'),
    read: pick('read'),
    write: pick('write'),
    phase: pick('phase') ?? (() => {}),
    log: pick('log') ?? (() => {}),
  }
}

export async function run(args, hostOverride) {
  // The previous contract was run(host, args). A caller still passing bridges first gets a
  // loud block, not a run against a host shape the kernel no longer provides.
  if (args && typeof args.agent === 'function') {
    return {
      status: 'blocked',
      blockedAtBatch: 0,
      reason: "build-flow runner: run() takes ONE argument, the args object. The eval kernel's agent/read/write/log/phase globals are bound by the module itself — call run(args) and never pass a host object.",
      ledger: emptyLedger(),
      results: [],
    }
  }
  const host = bindHost(hostOverride)
  if (typeof host.agent !== 'function') {
    return {
      status: 'blocked',
      blockedAtBatch: 0,
      reason: 'build-flow runner: no agent() global — this module must run from an OMP eval cell (language: js), where the kernel installs agent(); it cannot run under bash, node, or bun.',
      ledger: emptyLedger(),
      results: [],
    }
  }
  const { agent, read, write, phase, log } = host

  // `args` SHOULD be a structured object. Callers sometimes pass a JSON-encoded string by
  // mistake, which makes `args.batches` undefined and the whole run a silent no-op —
  // normalize defensively, and fail loud rather than reporting a fake `done`.
  let a = args ?? {}
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch (e) {
      return {
        status: 'blocked',
        blockedAtBatch: 0,
        reason: `build-flow runner: args arrived as a string that is not valid JSON (${e.message}). Pass args as a structured object, not a JSON-encoded string.`,
        ledger: emptyLedger(),
        results: [],
      }
    }
  }
  const MAX_FIX_ROUNDS = a.maxFixRounds ?? 3
  const STAGE_TIMEOUT_MINUTES = Number.isFinite(a.stageTimeoutMinutes) && a.stageTimeoutMinutes > 0 ? a.stageTimeoutMinutes : 60
  const STAGE_TIMEOUT_SECONDS = Math.round(STAGE_TIMEOUT_MINUTES * 60)
  const SLUG = typeof a.slug === 'string' && /^[A-Za-z0-9._-]+$/.test(a.slug) ? a.slug : null
  const JOURNAL_PATH = SLUG ? `local://build-flow/${SLUG}.state.json` : null
  // Agents inherit the SESSION shell's cwd — not the path the orchestrator had in mind. A
  // launch from the wrong directory split-brains the run (some agents edit the main
  // checkout, reviewers see "no implementation", fixes land in the orphaned copy). When the
  // orchestrator passes the worktree, every prompt opens with a hard cd instruction.
  const WT = typeof a.worktree === 'string' && a.worktree.trim() ? a.worktree.trim() : null
  const wtHeader = WT
    ? `## Worktree\nALL work happens in ${WT}. Your session's working directory is a DIFFERENT checkout of this repo, and the file tools (read, edit, write, grep, glob) resolve relative paths against it, not against your shell. So: give every file tool an absolute path under ${WT}, and give every bash call \`cwd: "${WT}"\` (or start it with \`cd ${WT} &&\`). A relative path lands in the wrong checkout.\n\n`
    : ''
  const ledger = a.ledger ?? emptyLedger()
  const startBatch = a.startBatch ?? 0
  const batches = a.batches ?? []
  const results = []

  // No batches almost always means a malformed launch (args stringified, or a plan that
  // parsed into zero tasks). Block loudly instead of returning `done` with zero work — a
  // fake success is the worst outcome because it looks like the plan ran.
  if (!Array.isArray(batches) || batches.length === 0) {
    return {
      status: 'blocked',
      blockedAtBatch: startBatch,
      reason: 'build-flow runner: no batches to execute. args.batches was empty or missing — check that args was passed as a structured object (not a JSON-encoded string) and that the plan parsed into at least one task.',
      ledger,
      results,
    }
  }

  // Each batch must be a bare array of task objects. A common mis-shaping is wrapping tasks
  // in an object (e.g. { index, tasks: [...] }), which would crash `for (const task of batch)`
  // with an opaque "not iterable" error. Block loudly with a shape hint instead.
  const badBatch = batches.findIndex((batch) => !Array.isArray(batch))
  if (badBatch !== -1) {
    return {
      status: 'blocked',
      blockedAtBatch: badBatch,
      reason: `build-flow runner: batch ${badBatch} is not an array of tasks. Each batch must be a bare array like [ { id, title, prompt }, ... ] — not an object (e.g. { index, tasks: [...] }). Fix the batches shape in args.`,
      ledger,
      results,
    }
  }
  const VERIFY_BATCH = batches.length // journal batch index for the verify phase: after every real batch

  // Journal: every finished stage's result, keyed by label, so a relaunch with the same
  // slug replays finished stages instead of re-spawning them. A crash, a cancelled job, or
  // an aborted cell loses nothing that already settled. A `blocked` return drops the
  // blocked batch's entries (and everything after it) so the relaunch re-runs exactly what
  // the human resolved; a run that ended `done` is never replayed.
  const journal = { status: 'running', nextBatch: startBatch, stages: {} }
  if (JOURNAL_PATH && typeof read === 'function') {
    try {
      const prior = JSON.parse(await read(JOURNAL_PATH))
      if (prior && prior.status !== 'done' && prior.stages && typeof prior.stages === 'object') journal.stages = prior.stages
    } catch {
      // first run, or unreadable: start fresh
    }
  }
  const saveJournal = async () => {
    if (!JOURNAL_PATH || typeof write !== 'function') return
    try {
      await write(JOURNAL_PATH, JSON.stringify({ slug: SLUG, status: journal.status, nextBatch: journal.nextBatch, ledger, results, stages: journal.stages }, null, 2))
    } catch (e) {
      log(`journal write failed (${errorText(e)}); continuing without resume support`)
    }
  }
  const replayable = Object.keys(journal.stages).length
  if (replayable > 0) log(`Journal ${JOURNAL_PATH}: ${replayable} finished stage(s) will replay`)

  // stage(): spawn one agent, wait for it, journal the result. Never throws — a rejected
  // wait (agent failed, off-schema output, cancelled) or a stage timeout becomes
  // { ok: false } naming the agent id, and the caller turns that into a `blocked` return.
  // The journal is keyed by the bare stage name; the agent label is `<slug>-<stage>` when a
  // slug is set, because agent ids are session-wide and a second run in the same session
  // would otherwise have its `impl-T1` uniquified to `impl-T1-2` (and `history://impl-T1`
  // would name the earlier run). Labels use hyphens because ':' is the read-selector
  // separator in agent:// URLs.
  const stage = async (batchIndex, name, prompt, opts) => {
    const prior = journal.stages[name]
    if (prior && typeof prior === 'object' && 'value' in prior) {
      log(`${name}: replaying journaled result`)
      return { ok: true, value: prior.value }
    }
    const label = SLUG ? `${SLUG}-${name}` : name
    let handle
    try {
      handle = await agent(prompt, { ...opts, label })
    } catch (e) {
      return { ok: false, id: label, error: `spawn failed: ${errorText(e)}` }
    }
    const id = handle && handle.id ? handle.id : label
    try {
      const value = await handle.wait({ timeout: STAGE_TIMEOUT_SECONDS })
      journal.stages[name] = { batch: batchIndex, value: value ?? null }
      await saveJournal()
      return { ok: true, value }
    } catch (e) {
      try {
        await handle.cancel()
      } catch {
        // already settled
      }
      const timedOut = e && e.name === 'TimeoutError'
      return { ok: false, id, error: timedOut ? `still running after ${STAGE_TIMEOUT_MINUTES} min (cancelled)` : errorText(e) }
    }
  }
  const stageFailure = (r) => PROVIDER_REFUSAL.test(r.error)
    ? `stage agent ${r.id} did not complete: ${r.error}. ${REFUSAL_ADVICE} When they say to continue, relaunch with the same args and slug — finished stages replay from the journal.`
    : `stage agent ${r.id} did not complete: ${r.error}. Read history://${r.id}, then relaunch with the same args and slug — finished stages replay from the journal.`
  const blocked = async (blockedAtBatch, dropFromBatch, reason, extra) => {
    for (const [label, entry] of Object.entries(journal.stages)) {
      if (!entry || typeof entry.batch !== 'number' || entry.batch >= dropFromBatch) delete journal.stages[label]
    }
    journal.status = 'blocked'
    await saveJournal()
    return { status: 'blocked', blockedAtBatch, reason, ledger, results, ...(extra ?? {}) }
  }
  const actionable = (fs) => fs.filter((f) => f && (f.severity === 'critical' || f.severity === 'important'))
  // A relaunch that both replays a batch from the journal AND carries the ledger returned by
  // the blocked run would record that batch's decision twice; skip exact repeats.
  const decide = (decision) => {
    if (!ledger.decisions.includes(decision)) ledger.decisions.push(decision)
  }

  const IMPL_SCHEMA = {
    type: 'object',
    required: ['summary', 'filesTouched', 'testsPassed'],
    properties: {
      summary: { type: 'string', description: 'MAX 120 words; summarize, cite files by path, never paste file bodies' },
      filesTouched: { type: 'array', items: { type: 'string' } },
      testsPassed: { type: 'boolean' },
      needsHumanInput: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', description: 'MAX 120 words; summarize, cite files by path, never paste file bodies' } },
      },
    },
  }

  const REVIEW_SCHEMA = {
    type: 'object',
    required: ['approved', 'findings'],
    properties: {
      approved: { type: 'boolean' },
      findings: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          required: ['severity', 'issue'],
          properties: {
            severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
            file: { type: 'string' },
            line: { type: 'integer' },
            issue: { type: 'string', description: 'MAX 60 words; summarize, cite files by path, never paste file bodies' },
            fix: { type: 'string', description: 'MAX 60 words; summarize, cite files by path, never paste file bodies' },
          },
        },
      },
    },
  }

  const VERIFY_SCHEMA = {
    type: 'object',
    required: ['passed', 'summary'],
    properties: {
      passed: { type: 'boolean' },
      summary: { type: 'string', description: 'MAX 60 words; e.g. "412 tests pass, lint clean" or what failed' },
      failures: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          required: ['check', 'detail'],
          properties: {
            check: { type: 'string', description: 'failing test name or lint rule' },
            detail: { type: 'string', description: 'MAX 30 words; file + expected vs actual — never paste logs' },
          },
        },
      },
    },
  }

  const ledgerText = (l) =>
    `Decisions: ${l.decisions.join(' | ') || 'none'}\n` +
    `Conventions: ${l.conventions.join(' | ') || 'none'}\n` +
    `Deviations: ${l.deviations.join(' | ') || 'none'}`

  const batchText = (batch) => batch.map((t) => `- ${t.id}: ${t.title}`).join('\n')

  const findingsText = (fs) =>
    fs.map((f) => `- [${f.severity}] ${f.file ?? '?'}:${f.line ?? '?'} — ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ''}`).join('\n')

  const implPrompt = (task) =>
    `${wtHeader}You are implementing ONE task from an approved plan, in the current git worktree. Do NOT commit — implement and test only.

## Task
${task.prompt}

## Cross-task ledger (decisions/conventions so far)
${ledgerText(ledger)}

## How to work
- Follow TDD: write the failing test FIRST, run it to confirm it fails, then implement the minimal code to pass.
- Follow existing patterns in the codebase. YAGNI — build only what the task specifies.
- Run ONLY the tests relevant to this task, with a quiet reporter; confirm they pass. Never run the full suite — a final verification stage runs it once at the end of the run. Do not commit.
- Keep your context lean: read files in relevant sections rather than whole files; pipe long command output through filters (\`tail\`, \`grep\`) instead of dumping it.
- Self-review before reporting: completeness vs the task, clear names, no overbuilding, tests verify real behavior.

## If you cannot proceed
If the task is ambiguous, underspecified, contradicts the codebase, needs an unplanned decision, or would require a destructive/irreversible action — STOP and set needsHumanInput.reason describing exactly what you need. Do not guess.`

  const specPrompt = (batch) =>
    `${wtHeader}You are a spec-compliance reviewer. Verify the uncommitted changes match the tasks below — nothing more, nothing less. Inspect the diff yourself (e.g. \`git diff main\`); do NOT trust any implementer summary.

## Tasks in this batch
${batchText(batch)}

## Cross-task ledger
${ledgerText(ledger)}

Check: missing requirements, extra/unrequested work, misunderstandings. Use the ledger to catch inconsistencies with earlier batches (e.g. an earlier task used pattern X, this batch uses Y). Verify by reading code. Return approved + findings (severity critical|important|minor, with file/line/issue/fix).`

  const qualityPrompt = (batch) =>
    `${wtHeader}You are a code-quality reviewer. Review the uncommitted changes (\`git diff main\`) for the tasks below.

## Tasks in this batch
${batchText(batch)}

## Cross-task ledger
${ledgerText(ledger)}

Check: separation of concerns, error handling, type safety, DRY, edge cases; sound design and security; tests verify real behavior (not mocks), edge cases covered, all passing. Flag architectural drift across batches using the ledger. Return approved + findings (severity critical|important|minor, with file/line/issue/fix).`

  const fixPrompt = (batch, findings) =>
    `${wtHeader}Reviewers found issues in the current batch. Fix each one in the worktree (do NOT commit), then re-run ONLY the affected tests (quiet reporter) to confirm — never the full suite.

## Findings to fix
${findingsText(findings)}

## Batch tasks (context)
${batchText(batch)}

## Cross-task ledger
${ledgerText(ledger)}

If a finding is wrong or impossible to satisfy, set needsHumanInput.reason instead of guessing. Return a summary, files touched, and whether tests passed.`

  const recheckPrompt = (batch, findings) =>
    `${wtHeader}A fix agent just addressed the review findings below in the current worktree. Verify the fixes — do NOT re-review the whole batch.

## Findings that were supposedly fixed
${findingsText(findings)}

## Batch tasks (context)
${batchText(batch)}

Inspect the current code yourself (targeted diffs on the affected files); do not trust the fixer's summary. Check each finding is genuinely resolved and that the fix introduced no new problem in the code it touched. Return approved + findings containing ONLY findings that remain unresolved or were newly introduced by the fixes (severity critical|important|minor).`

  const verifyPrompt = () =>
    `${wtHeader}Final verification for the whole run, in the current git worktree. Do NOT change any code.

1. Discover the project's full test and lint commands (package.json scripts, Makefile, mise.toml, pyproject.toml, etc.).
2. Run the FULL test suite, then the linter. Keep your context lean: use quiet reporters where available and pipe output through a filter (e.g. \`... 2>&1 | tail -40\`) so only summaries and failures enter your context — never read full passing output.
3. Return passed=true only if both are clean. On failure, return one entry per failing test/lint rule with a one-line detail an independent fix agent can act on (file, expected vs actual) — never paste logs.`

  const verifyFixPrompt = (verification) =>
    `${wtHeader}The final full-suite verification failed. Fix each failure in the worktree (do NOT commit), then re-run ONLY the affected tests/lint rules with a quiet reporter to confirm — the verifier re-runs the full suite after you.

## Failures
${(verification.failures ?? []).map((f) => `- ${f.check}: ${f.detail}`).join('\n')}

## Cross-task ledger
${ledgerText(ledger)}

If a failure is pre-existing on the base branch or needs an unplanned decision, set needsHumanInput.reason instead of guessing.`

  for (let b = startBatch; b < batches.length; b++) {
    const batch = batches[b]
    const n = b + 1
    phase('Implement')
    log(`Batch ${n}/${batches.length}: implementing ${batch.length} task(s)`)

    // Implement sequentially within a batch (parallel file-writers would need worktree isolation — deferred).
    for (const task of batch) {
      const r = await stage(b, `impl-${task.id}`, implPrompt(task), { agent: WORKER, schema: IMPL_SCHEMA })
      if (!r.ok) return blocked(b, b, stageFailure(r))
      if (r.value && r.value.needsHumanInput) return blocked(b, b, r.value.needsHumanInput.reason)
      if (r.value) results.push({ batch: b, task: task.id, ...r.value })
    }

    // Review gate: ONE full spec+quality review per batch, then a staged fix-loop
    // with scoped re-checks. Re-checks verify the specific findings and the code
    // the fixes touched — never a second full review (reviews outnumbering
    // implementation 2:1 was the single largest measured token sink).
    phase('Review')
    const finalBatch = b === batches.length - 1
    const [spec, quality] = await Promise.all([
      stage(b, `spec-b${n}`, specPrompt(batch), { agent: WORKER, schema: REVIEW_SCHEMA }),
      // The final batch's `git diff main` covers the whole run, so its quality review
      // escalates to kit-arbiter as the run-level safety net.
      stage(b, `quality-b${n}`, qualityPrompt(batch), { agent: finalBatch ? ARBITER : WORKER, schema: REVIEW_SCHEMA }),
    ])
    for (const r of [spec, quality]) if (!r.ok) return blocked(b, b, stageFailure(r))
    let findings = actionable([...(spec.value?.findings ?? []), ...(quality.value?.findings ?? [])])
    let round = 0
    while (findings.length > 0) {
      if (round >= MAX_FIX_ROUNDS) {
        return blocked(b, b, `Review unresolved after ${MAX_FIX_ROUNDS} fix round(s)`, { findings })
      }
      phase('Fix')
      const fixAgent = round < MAX_FIX_ROUNDS - 1 ? WORKER : ARBITER // staged escalation
      log(`Batch ${n} fix round ${round + 1} (${fixAgent}): ${findings.length} finding(s)`)
      const fix = await stage(b, `fix-b${n}-r${round + 1}`, fixPrompt(batch, findings), { agent: fixAgent, schema: IMPL_SCHEMA })
      if (!fix.ok) return blocked(b, b, stageFailure(fix), { findings })
      if (fix.value && fix.value.needsHumanInput) return blocked(b, b, fix.value.needsHumanInput.reason, { findings })
      round++
      const recheck = await stage(b, `recheck-b${n}-r${round}`, recheckPrompt(batch, findings), { agent: WORKER, schema: REVIEW_SCHEMA })
      if (!recheck.ok) return blocked(b, b, stageFailure(recheck), { findings })
      findings = actionable(recheck.value?.findings ?? [])
    }

    decide(`Batch ${n} (${batch.map((t) => t.id).join(', ')}) implemented and reviewed clean.`)
    journal.nextBatch = b + 1
    await saveJournal()
    log(`Batch ${n} complete.`)
  }

  // Final verification: the ONE place the full suite + linter run. Batch agents
  // run only task-scoped tests, and the structured summary keeps raw test output
  // out of the orchestrator's context entirely. A block here drops only the verify
  // phase from the journal, so the relaunch replays every batch and re-verifies.
  phase('Verify')
  let verification = null
  for (let v = 0; ; v++) {
    const ver = await stage(VERIFY_BATCH, `verify-r${v + 1}`, verifyPrompt(), { agent: VERIFIER, schema: VERIFY_SCHEMA })
    if (!ver.ok) return blocked(VERIFY_BATCH - 1, VERIFY_BATCH, stageFailure(ver))
    verification = ver.value
    if (!verification || verification.passed) break
    if (v >= 2) {
      return blocked(VERIFY_BATCH - 1, VERIFY_BATCH, `Final verification still failing after ${v} fix round(s): ${verification.summary}`, { findings: verification.failures })
    }
    log(`Final verification failed (${verification.failures?.length ?? 0} failure(s)) — fix round ${v + 1}`)
    const fixAgent = v === 0 ? WORKER : ARBITER // staged escalation
    const fix = await stage(VERIFY_BATCH, `verify-fix-r${v + 1}`, verifyFixPrompt(verification), { agent: fixAgent, schema: IMPL_SCHEMA })
    if (!fix.ok) return blocked(VERIFY_BATCH - 1, VERIFY_BATCH, stageFailure(fix), { findings: verification.failures })
    if (fix.value && fix.value.needsHumanInput) {
      return blocked(VERIFY_BATCH - 1, VERIFY_BATCH, fix.value.needsHumanInput.reason, { findings: verification.failures })
    }
  }
  decide(`Final verification: ${verification ? verification.summary : 'verifier returned no result'}`)
  journal.status = 'done'
  journal.nextBatch = VERIFY_BATCH
  await saveJournal()

  return { status: 'done', results, ledger, verification }
}
