export const meta = {
  name: 'code-review-runner',
  description: 'Standalone diff/PR review: fan out review dimensions, adversarially verify each finding, return a consolidated report. A reviewer or verifier that does not complete is reported by label (status: partial) instead of silently thinning the review.',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
  ],
}

// args: { diffRef?: string, reviewDims?: {key,focus,agent}[], ledger?: object }

const diffRef = args.diffRef ?? 'main'
const ledgerText = args.ledger ? JSON.stringify(args.ledger) : 'none'
// Sonnet-first: measured across 6 weeks of runs, 69% of review agents return zero actionable
// findings. Architecture keeps kit-arbiter (Opus) as the one deep-judgment safety net.
const WORKER = 'kit:kit-worker'
const ARBITER = 'kit:kit-arbiter'
const DIMS = args.reviewDims ?? [
  { key: 'correctness', focus: 'logic errors, bugs, broken edge cases, race conditions', agent: WORKER },
  { key: 'quality', focus: 'separation of concerns, DRY, naming, error handling, maintainability', agent: WORKER },
  { key: 'tests', focus: 'tests verify real behavior (not mocks), edge cases covered, all passing', agent: WORKER },
  { key: 'security', focus: 'injection, auth, secrets, unsafe operations', agent: WORKER },
  { key: 'architecture', focus: 'plan/design alignment, module boundaries, sound abstractions, scalability', agent: ARBITER },
]

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

// stage(): spawn one agent and classify its result. The Workflow runtime resolves agent() to
// null when the agent was stopped in /workflows or hit an unrecoverable API error. A dead
// reviewer must not read as "no findings", and a dead verifier must not read as "not real":
// both are recorded by label and the review degrades to `partial`.
const failed = []
const stage = async (label, prompt, opts) => {
  const value = await agent(prompt, { ...opts, label })
  if (value == null) failed.push({ id: label, error: 'did not complete (stopped in /workflows, or an unrecoverable API error such as a provider rate limit; if the provider refused the request, report this to the user and wait for direction)' })
  return value
}

const reviewed = await pipeline(
  DIMS,
  (d) => stage(
    `review:${d.key}`,
    `Review the diff \`git diff ${diffRef}\` for the "${d.key}" dimension: ${d.focus}.\nCross-task ledger: ${ledgerText}.\nVerify by reading the actual code. Return findings (severity critical|important|minor, with file/line/issue/fix).`,
    { phase: 'Review', agentType: d.agent, schema: FINDINGS_SCHEMA },
  ),
  (r, d) => parallel(((r && r.findings) || []).map((f, i) => () =>
    stage(
      `verify:${d.key}:${i + 1}`,
      `Adversarially check whether this ${d.key} finding is REAL (not a false positive): "${f.issue}" at ${f.file ?? '?'}:${f.line ?? '?'}. Read the code. Default to real=false if uncertain.`,
      { phase: 'Verify', agentType: WORKER, schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...f, dimension: d.key, verified: !!(v && v.real), unverified: v == null })),
  )),
)

const all = reviewed.flat().filter(Boolean)
const findings = all.filter((f) => f.verified).map(({ unverified: _u, ...f }) => f)
// A finding whose verifier died is neither confirmed nor refuted; report it separately so
// the reader knows a dimension's finding went unchecked instead of silently disappearing.
const unverified = all.filter((f) => f.unverified).map(({ unverified: _u, verified: _v, ...f }) => f)
return failed.length > 0
  ? { status: 'partial', diffRef, findings, unverified, failed }
  : { status: 'done', diffRef, findings }
