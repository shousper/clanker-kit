export const meta = {
  name: 'code-review-runner-omp',
  description: 'Standalone diff/PR review: fan out review dimensions, adversarially verify each finding, return a consolidated report. Never throws or hangs: every agent is bounded by a timeout, and a dimension that fails is reported by id instead of aborting the review. OMP-native: dimension and verification agents are selected inline.',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
  ],
}

// Host bridges: bound from the eval kernel's globals exactly as in build.workflow.mjs
// (see the comment there). run(args, hostOverride?) — never pass a host as the first argument.

// args: { diffRef?: string, slug?: string, reviewDims?: {key,focus,agent}[], ledger?: object, stageTimeoutMinutes?: number }
// returns: { status, diffRef, findings, agents: { [label]: spawnedId }, failed? }

const WORKER = 'kit-worker'
const ARBITER = 'kit-arbiter'

// A provider that refuses work (rate limit, overload, exhausted quota) is not fixed by a
// relaunch or a different agent: which models to use is the user's call.
const PROVIDER_REFUSAL = /\b(429|529)\b|rate.?limit|overloaded|quota|usage limit/i
const REFUSAL_ADVICE = 'The model provider refused the request. Report this to the user and wait for direction.'

const errorText = (e) => (e && e.message ? e.message : String(e))
const failureText = (text) => (PROVIDER_REFUSAL.test(text) ? `${text}. ${REFUSAL_ADVICE}` : text)

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'issue'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['real'],
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
}

function bindHost(override) {
  const pick = (name) => (override && override[name] !== undefined ? override[name] : globalThis[name])
  return {
    agent: pick('agent'),
    phase: pick('phase') ?? (() => {}),
    log: pick('log') ?? (() => {}),
  }
}

export async function run(args, hostOverride) {
  if (args && typeof args.agent === 'function') {
    return {
      status: 'blocked',
      reason: "code-review runner: run() takes ONE argument, the args object. The eval kernel's agent/log/phase globals are bound by the module itself — call run(args) and never pass a host object.",
      diffRef: null,
      findings: [],
    }
  }
  const host = bindHost(hostOverride)
  if (typeof host.agent !== 'function') {
    return {
      status: 'blocked',
      reason: 'code-review runner: no agent() global — this module must run from an OMP eval cell (language: js), where the kernel installs agent(); it cannot run under bash, node, or bun.',
      diffRef: null,
      findings: [],
    }
  }
  const { agent, phase, log } = host
  const a = args ?? {}
  const diffRef = a.diffRef ?? 'main'
  const ledgerText = a.ledger ? JSON.stringify(a.ledger) : 'none'
  const STAGE_TIMEOUT_MINUTES = Number.isFinite(a.stageTimeoutMinutes) && a.stageTimeoutMinutes > 0 ? a.stageTimeoutMinutes : 60
  const STAGE_TIMEOUT_SECONDS = Math.round(STAGE_TIMEOUT_MINUTES * 60)
  // Agent ids are session-wide, so a second review in the same session reusing the bare
  // labels gets them uniquified (`review-correctness-2`) and `history://review-correctness`
  // then names the FIRST run. A slug namespaces this run's labels; either way the ids
  // actually spawned come back in `agents` so the caller never has to guess.
  const SLUG = typeof a.slug === 'string' && /^[A-Za-z0-9._-]+$/.test(a.slug) ? a.slug : null
  const labelFor = (name) => (SLUG ? `${SLUG}-${name}` : name)
  const agents = {}
  // kit-worker-first: measured across 6 weeks of runs, 69% of review agents return zero
  // actionable findings — kit-arbiter everywhere was paying frontier rates for "LGTM".
  // Architecture keeps kit-arbiter as the one deep-judgment safety net.
  const DIMS = a.reviewDims ?? [
    { key: 'correctness', focus: 'logic errors, bugs, broken edge cases, race conditions', agent: WORKER },
    { key: 'quality', focus: 'separation of concerns, DRY, naming, error handling, maintainability', agent: WORKER },
    { key: 'tests', focus: 'tests verify real behavior (not mocks), edge cases covered, all passing', agent: WORKER },
    { key: 'security', focus: 'injection, auth, secrets, unsafe operations', agent: WORKER },
    { key: 'architecture', focus: 'plan/design alignment, module boundaries, sound abstractions, scalability', agent: ARBITER },
  ]

  // stage(): spawn, wait with a timeout, never throw. A failure is recorded by agent id and
  // the stage yields null, so one dead reviewer degrades the review to `partial` instead of
  // losing every other dimension's work.
  const failed = []
  const stage = async (name, prompt, opts) => {
    const label = labelFor(name)
    let handle
    try {
      handle = await agent(prompt, { ...opts, label })
    } catch (e) {
      failed.push({ id: label, error: failureText(`spawn failed: ${errorText(e)}`) })
      return null
    }
    const id = handle && handle.id ? handle.id : label
    agents[label] = id
    try {
      return await handle.wait({ timeout: STAGE_TIMEOUT_SECONDS })
    } catch (e) {
      try {
        await handle.cancel()
      } catch {
        // already settled
      }
      const timedOut = e && e.name === 'TimeoutError'
      failed.push({ id, error: timedOut ? `still running after ${STAGE_TIMEOUT_MINUTES} min (cancelled)` : failureText(errorText(e)) })
      return null
    }
  }

  // Review each dimension (one wave), then adversarially verify every finding it raised
  // (a second wave) — a false positive costs a fix cycle, so nothing is reported unverified.
  phase('Review')
  log(`Reviewing \`git diff ${diffRef}\` across ${DIMS.length} dimension(s)`)
  const reviewed = await Promise.all(
    DIMS.map((d) =>
      stage(
        `review-${d.key}`,
        `Review the diff \`git diff ${diffRef}\` for the "${d.key}" dimension: ${d.focus}.\nCross-task ledger: ${ledgerText}.\nVerify by reading the actual code. Return findings (severity critical|important|minor, with file/line/issue/fix).`,
        { agent: d.agent, schema: FINDINGS_SCHEMA },
      ),
    ),
  )

  phase('Verify')
  const candidates = reviewed.flatMap((r, i) => ((r && r.findings) || []).map((f) => ({ ...f, dimension: DIMS[i].key })))
  log(`Verifying ${candidates.length} candidate finding(s)`)
  const verdicts = await Promise.all(
    candidates.map((f, i) =>
      stage(
        `verify-${f.dimension}-${i + 1}`,
        `Adversarially check whether this ${f.dimension} finding is REAL (not a false positive): "${f.issue}" at ${f.file ?? '?'}:${f.line ?? '?'}. Read the code. Default to real=false if uncertain.`,
        { agent: WORKER, schema: VERDICT_SCHEMA },
      ),
    ),
  )

  const findings = candidates
    .map((f, i) => ({ ...f, verified: !!(verdicts[i] && verdicts[i].real) }))
    .filter((f) => f.verified)
  return failed.length > 0
    ? { status: 'partial', diffRef, findings, failed, agents }
    : { status: 'done', diffRef, findings, agents }
}
