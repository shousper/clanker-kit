export const meta = {
  name: 'story-planners-omp',
  description: 'Dispatches execution-time story planners at OMP agents pinned by story complexity (story-planner-routine|hard|frontier). Parallel across stories; no fallback path — a failed planner reports planner-failed, never a lesser tier.',
  phases: [{ title: 'Plan' }],
}

// Host bridges: the OMP eval kernel installs agent/log/phase/write as globals of its worker VM,
// so run() binds them itself; the launching cell passes the args array and nothing else.
// The optional second parameter overrides individual bridges (tests use it; a launch never
// should). agent(prompt, { agent, label, schema }) returns a handle at once; the result
// comes from `await handle.wait({ timeout })` (SECONDS, in an options object), which
// rejects when the agent failed, yielded off-schema, was cancelled, or timed out.
//
// Every planned story is also written to local://stories/<id>.plan.md (the plan, for
// `story update --plan-file`) and local://stories/<id>.plan.json (the whole row, for
// build-flow's batches). A backgrounded cell's return value reaches the worker through a
// truncating job snapshot; the files are the durable copy it reads instead.

// args: [ { id, complexity, worktree, storyBody }, ... ] — one entry per claimed story.
// The worker session passes data only; every tier decision lives in THIS file.

// Complexity → OMP agent. Deliberately CODE, not prose: the worker never chooses,
// retries, or substitutes a planner, and no downgrade branch exists here. An unknown
// complexity is a FAILURE, not a fallback (complexity is CLI-validated at create/update,
// so this only fires on a mangled args payload).
const TIER = {
  routine: 'story-planner-routine',
  hard: 'story-planner-hard',
  frontier: 'story-planner-frontier', // human opt-in, made at board approval
}
const PLANNER_TIMEOUT_SECONDS = 30 * 60

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plan: { type: 'string', description: 'Implementation plan markdown: numbered steps, exact file paths, what each test proves. Becomes the story\'s permanent plan of record.' },
    batches: {
      type: 'array',
      description: 'Dependency-ordered batches of bite-sized TDD tasks. One batch unless tasks genuinely must land sequentially.',
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' } },
          required: ['id', 'title', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    unimplementable: {
      type: 'object',
      description: 'Set INSTEAD of plan/batches when the story cannot be implemented as specified.',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

const plannerPrompt = (s) => [
  `You are the execution-time planner for story ${s.id}.`,
  `ALL exploration happens in the story worktree: run \`cd ${s.worktree}\` FIRST. Explore the code there and verify every file pointer in the story against reality — prerequisites may have merged since the story was written.`,
  '',
  '## Story (the complete spec — do not re-read the board)',
  '',
  String(s.storyBody ?? ''),
  '',
  '## Output contract',
  '',
  'Return `plan` (markdown: numbered steps, exact file paths, what each test proves) and `batches` (dependency-ordered batches of task objects {id, title, prompt}; each prompt fully self-contained — an implementer with zero context must execute it without reading the story; one batch unless tasks genuinely must land sequentially).',
  'If the story is unimplementable as specified (contradicts the code, missing prerequisite), return `unimplementable` with a specific, answerable question INSTEAD — never a made-up plan.',
].join('\n')

// A provider that refuses work (rate limit, overload, exhausted quota) is not fixed by a
// relaunch or a different agent: which models to use is the user's call.
const PROVIDER_REFUSAL = /\b(429|529)\b|rate.?limit|overloaded|quota|usage limit/i
const REFUSAL_ADVICE = 'The model provider refused the request. Report this to the user and wait for direction.'

const blocked = (reason) => ({ status: 'blocked', reason, planned: [], unimplementable: [], failed: [] })
const errorText = (e) => (e && e.message ? e.message : String(e))

// OMP raises this before the child starts when the agent's whole model chain resolves to
// nothing. Name the agent so the parked question is actionable.
const failure = (tier, e) => {
  const text = errorText(e)
  if (/no model/i.test(text)) {
    return `no model resolves for agent ${tier} (its chain uses OMP's built-in plan/slow/default roles) — park the story and report this to your human partner; there is no alternative-tier path`
  }
  if (PROVIDER_REFUSAL.test(text)) {
    return `planner agent did not complete: ${text}. ${REFUSAL_ADVICE} Park the story meanwhile; there is no alternative-tier path`
  }
  return `planner agent did not complete: ${text} — park the story; there is no alternative-tier path`
}

function bindHost(override) {
  const pick = (name) => (override && override[name] !== undefined ? override[name] : globalThis[name])
  return { agent: pick('agent'), phase: pick('phase') ?? (() => {}), log: pick('log') ?? (() => {}), write: pick('write') }
}

async function persist(write, row) {
  if (typeof write !== 'function') return
  await write(`local://stories/${row.id}.plan.md`, row.plan)
  await write(`local://stories/${row.id}.plan.json`, JSON.stringify(row, null, 2))
}

export async function run(args, hostOverride) {
  if (args && typeof args.agent === 'function') {
    return blocked("story-planners: run() takes ONE argument, the args array. The eval kernel's agent/log/phase globals are bound by the module itself — call run(args) and never pass a host object.")
  }
  const host = bindHost(hostOverride)
  if (typeof host.agent !== 'function') {
    return blocked('story-planners: no agent() global — this module must run from an OMP eval cell (language: js), where the kernel installs agent(); it cannot run under bash, node, or bun.')
  }
  const { agent, phase, log, write } = host

  let a = args ?? []
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch (e) {
      return blocked(`story-planners: args arrived as a string that is not valid JSON (${e.message}). Pass args as a structured array.`)
    }
  }
  if (!Array.isArray(a) || a.length === 0) {
    return blocked('story-planners: args must be a non-empty array of {id, complexity, worktree, storyBody}.')
  }

  phase('Plan')
  const rows = await Promise.all(a.map(async (s) => {
    const tier = TIER[s.complexity ?? 'routine']
    if (!tier) return { id: s.id, status: 'planner-failed', error: `unknown complexity '${s.complexity}'` }
    let handle
    try {
      handle = await agent(plannerPrompt(s), { agent: tier, label: `plan-${s.id}`, schema: PLAN_SCHEMA })
    } catch (e) {
      return { id: s.id, status: 'planner-failed', agent: tier, error: failure(tier, e) }
    }
    let r
    try {
      r = await handle.wait({ timeout: PLANNER_TIMEOUT_SECONDS })
    } catch (e) {
      try {
        await handle.cancel()
      } catch {
        // already settled
      }
      const timedOut = e && e.name === 'TimeoutError'
      return { id: s.id, status: 'planner-failed', agent: tier, error: `${failure(tier, e)}${timedOut ? ' (cancelled)' : ''}` }
    }
    if (!r) {
      return { id: s.id, status: 'planner-failed', agent: tier, error: 'planner agent returned nothing — park the story; there is no alternative-tier path' }
    }
    if (r.unimplementable) {
      return { id: s.id, status: 'unimplementable', agent: tier, question: r.unimplementable.question }
    }
    if (typeof r.plan === 'string' && r.plan.trim() && Array.isArray(r.batches) && r.batches.length > 0) {
      const row = { id: s.id, status: 'planned', agent: tier, plan: r.plan, batches: r.batches }
      await persist(write, row)
      return row
    }
    return { id: s.id, status: 'planner-failed', agent: tier, error: 'planner returned neither a complete plan+batches nor an unimplementable question' }
  }))

  log(`planned ${rows.filter((r) => r.status === 'planned').length}/${a.length}`)
  return {
    status: 'done',
    planned: rows.filter((r) => r.status === 'planned'),
    unimplementable: rows.filter((r) => r.status === 'unimplementable'),
    failed: rows.filter((r) => r.status === 'planner-failed'),
  }
}
