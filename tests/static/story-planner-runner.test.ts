import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { STORIES_CLAUDE_ROOT } from "../utils/paths";
import { meta as ompMeta, run as runOmp } from "../../plugins/stories-omp/skills/work/plan.workflow.mjs";

// The two planner runners share one input shape and one envelope; only the launch
// runtime differs. The Claude file is authored against the Workflow runtime (globals
// args/agent/parallel/phase/log, top-level await and return), replicated here as an
// AsyncFunction. The OMP module binds the eval kernel's globals; tests inject them.

const CLAUDE_SRC = readFileSync(resolve(STORIES_CLAUDE_ROOT, "skills/work/plan.workflow.js"), "utf-8").replace("export const meta", "const meta");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<any>;

type Row = { id: string; status: string; plan?: string; batches?: unknown[]; question?: string; error?: string; model?: string; agent?: string };
type Envelope = { status: string; reason?: string; planned: Row[]; unimplementable: Row[]; failed: Row[] };
type ClaudeOpts = { label?: string; agentType?: string; model?: string; effort?: string; schema?: unknown };
type OmpOpts = { agent?: string; label?: string; schema?: unknown };
type Respond = (prompt: string) => unknown;
const HANGS = Symbol("hangs");

async function runClaude(args: unknown, respond?: Respond) {
  const calls: ClaudeOpts[] = [];
  const agent = async (prompt: string, opts: ClaudeOpts) => {
    calls.push(opts);
    if (!respond) throw new Error("agent() must not run for a rejected payload");
    return respond(prompt);
  };
  // The Workflow runtime's parallel() drops rejected thunks instead of rejecting the batch.
  const parallel = async (thunks: Array<() => Promise<unknown>>) =>
    (await Promise.allSettled(thunks.map((t) => t()))).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const fn = new AsyncFunction("args", "agent", "parallel", "phase", "log", CLAUDE_SRC);
  const out = (await fn(args, agent, parallel, () => {}, () => {})) as Envelope;
  return { out, calls };
}

async function runOmpRunner(args: unknown, respond?: Respond) {
  const calls: OmpOpts[] = [];
  const waits: unknown[] = [];
  const files: Record<string, string> = {};
  const agent = async (prompt: string, opts: OmpOpts) => {
    calls.push(opts);
    if (!respond) throw new Error("agent() must not run for a rejected payload");
    const outcome = Promise.resolve().then(() => respond(prompt));
    outcome.catch(() => {});
    return {
      id: opts.label,
      wait: async (o: unknown) => {
        waits.push(o);
        const v = await outcome;
        if (v === HANGS) throw Object.assign(new Error("still running"), { name: "TimeoutError" });
        return v;
      },
      cancel: async () => {},
      status: () => ({}),
    };
  };
  const write = async (path: string, content: string) => { files[path] = content; return path; };
  const out = (await runOmp(args, { agent, phase: () => {}, log: () => {}, write })) as Envelope;
  return { out, calls, waits, files };
}

const story = (id: string, complexity?: string) => ({ id, complexity, worktree: `/wt/${id}`, storyBody: `BODY:${id}` });
const planned = { plan: "1. do it", batches: [[{ id: "T1", title: "T1", prompt: "do it" }]] };
const bodyOf = (prompt: string) => /BODY:(st-\d+)/.exec(prompt)![1];

const RUNNERS = [["claude", runClaude], ["omp", runOmpRunner]] as const;

describe("planner runners: meta", () => {
  it("names the pair story-planners (Claude) and story-planners-omp (OMP), each with a description", () => {
    expect(CLAUDE_SRC).toMatch(/const meta = \{\s*name: ['"]story-planners['"]/);
    expect(ompMeta.name).toBe("story-planners-omp");
    expect(typeof ompMeta.description).toBe("string");
    expect(ompMeta.description.length).toBeGreaterThan(0);
  });
});

describe("planner runners: shared contract", () => {
  for (const [name, run] of RUNNERS) {
    it(`${name}: blocks on a non-JSON string, an empty array, and a non-array, without spawning`, async () => {
      for (const bad of ["not json {", [], {}, JSON.stringify([])]) {
        const { out, calls } = await run(bad);
        expect(out.status).toBe("blocked");
        expect(out.reason).toMatch(/args/);
        expect(calls).toEqual([]);
        expect(out.planned).toEqual([]);
        expect(out.failed).toEqual([]);
      }
    });

    it(`${name}: parses a JSON-string payload and buckets planned / unimplementable / failed by id`, async () => {
      const args = JSON.stringify([story("st-0001"), story("st-0002", "hard"), story("st-0003"), story("st-0004", "bogus")]);
      const { out } = await run(args, (prompt) =>
        bodyOf(prompt) === "st-0001" ? planned
        : bodyOf(prompt) === "st-0002" ? { unimplementable: { question: "which db?" } }
        : { plan: "", batches: [] });
      expect(out.status).toBe("done");
      expect(out.planned.map((r) => r.id)).toEqual(["st-0001"]);
      expect(out.planned[0].batches).toEqual(planned.batches);
      expect(out.unimplementable.map((r) => [r.id, r.question])).toEqual([["st-0002", "which db?"]]);
      expect(out.failed.map((r) => r.id).sort()).toEqual(["st-0003", "st-0004"]);
      expect(out.failed.find((r) => r.id === "st-0004")!.error).toMatch(/unknown complexity/);
    });

    it(`${name}: a planner that dies lands in failed, never in a lesser tier`, async () => {
      const { out, calls } = await run([story("st-0001"), story("st-0002")], (prompt) => {
        if (bodyOf(prompt) === "st-0002") throw new Error("provider exploded");
        return planned;
      });
      expect(out.status).toBe("done");
      expect(out.planned.map((r) => r.id)).toEqual(["st-0001"]);
      expect(out.failed.map((r) => r.id)).toEqual(["st-0002"]);
      expect(calls.length).toBe(2); // exactly one attempt per story: no retry, no fallback
    });

    it(`${name}: every prompt carries the story body and a cd into the story worktree`, async () => {
      const prompts: string[] = [];
      await run([story("st-0001")], (prompt) => { prompts.push(prompt); return planned; });
      expect(prompts[0]).toContain("BODY:st-0001");
      expect(prompts[0]).toContain("cd /wt/st-0001");
    });
  }
});

describe("planner runners: tier mapping", () => {
  it("claude names one agent per complexity", async () => {
    const { calls } = await runClaude([story("st-0001"), story("st-0002", "hard"), story("st-0003", "frontier")], () => planned);
    expect(calls.map((c) => c.agentType)).toEqual(["stories:story-planner-routine", "stories:story-planner-hard", "stories:story-planner-frontier"]);
    for (const c of calls) {
      expect(c).not.toHaveProperty("model");
      expect(c).not.toHaveProperty("effort");
    }
  });

  it("omp names one agent per complexity, with hyphenated labels, a schema, no model, and a bounded wait", async () => {
    const { calls, waits } = await runOmpRunner([story("st-0001"), story("st-0002", "hard"), story("st-0003", "frontier")], () => planned);
    expect(calls.map((c) => c.agent)).toEqual(["story-planner-routine", "story-planner-hard", "story-planner-frontier"]);
    for (const c of calls) {
      expect(c.label).toMatch(/^plan-st-\d+$/);
      expect(c.schema).toBeDefined();
      expect(c).not.toHaveProperty("model");
      expect(c).not.toHaveProperty("effort");
    }
    expect(waits).toEqual([{ timeout: 1800 }, { timeout: 1800 }, { timeout: 1800 }]);
  });

  it("omp treats a timed-out planner as failed and blocks when run() gets a host object or no agent global", async () => {
    const { out } = await runOmpRunner([story("st-0001")], () => HANGS);
    expect(out.failed.map((r) => r.id)).toEqual(["st-0001"]);
    expect(out.failed[0].error).toMatch(/did not complete/);
    expect(((await runOmp({ agent: async () => ({}) } as never)) as Envelope).status).toBe("blocked");
    expect(((await runOmp([story("st-0001")])) as Envelope).reason).toMatch(/agent\(\) global/);
  });

  it("omp writes each planned story's plan and batches to local://stories, and nothing for failures", async () => {
    const { files } = await runOmpRunner([story("st-0001"), story("st-0002")], (prompt) =>
      bodyOf(prompt) === "st-0001" ? planned : { plan: "", batches: [] });
    expect(Object.keys(files).sort()).toEqual(["local://stories/st-0001.plan.json", "local://stories/st-0001.plan.md"]);
    expect(files["local://stories/st-0001.plan.md"]).toBe(planned.plan);
    expect(JSON.parse(files["local://stories/st-0001.plan.json"])).toMatchObject({ id: "st-0001", status: "planned", batches: planned.batches });
  });

  it("omp turns a model-resolution failure into an error naming the agent, to report to the user", async () => {
    const { out } = await runOmpRunner([story("st-0001", "hard")], () => { throw new Error("No model selected.\n\nUse /login"); });
    expect(out.failed[0].error).toContain("story-planner-hard");
    expect(out.failed[0].error).toContain("report this to your human partner");
  });

  it("omp turns a provider refusal into advice to report to the user", async () => {
    const { out } = await runOmpRunner([story("st-0001")], () => { throw new Error("overloaded_error: Overloaded"); });
    expect(out.failed[0].error).toContain("The model provider refused the request. Report this to the user and wait for direction.");
  });
});
