import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { KIT_CLAUDE_ROOT } from "../utils/paths";

// The bundled runner is authored against the Workflow runtime, which injects globals
// (args, agent, parallel, phase, log), supports top-level await, and allows a top-level
// `return`. We replicate that contract here by compiling the source into an AsyncFunction
// so we can exercise the runner's input-handling and early-exit guards WITHOUT spawning
// real agents. This guards the failure that broke the first real build-flow run: `args`
// passed as a JSON string -> zero batches -> a silent `done` that looked like success.

const SRC = readFileSync(
  resolve(KIT_CLAUDE_ROOT, "skills", "build-flow", "build.workflow.js"),
  "utf-8",
).replace("export const meta", "const meta"); // `export` is illegal inside a Function body

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<any>;

type Run = {
  status?: string;
  reason?: string;
  blockedAtBatch?: number;
  results?: unknown[];
  findings?: Array<{ severity: string; issue: string }>;
  ledger?: { decisions: string[]; conventions: string[]; deviations: string[] };
  agentCalls: number;
};

type AgentOpts = { label?: string; phase?: string; agentType?: string; model?: string; effort?: string; schema?: unknown };

// agentImpl lets a test stand in for the implementer agent; by default any agent() call is
// a failure, which proves the guards return BEFORE doing work.
async function runRunner(
  args: unknown,
  agentImpl?: (prompt: string, opts?: AgentOpts) => Promise<unknown>,
): Promise<Run> {
  let agentCalls = 0;
  const agent = async (prompt: string, opts?: AgentOpts) => {
    agentCalls++;
    if (agentImpl) return agentImpl(prompt, opts);
    throw new Error("agent() must not run when there are no batches to build");
  };
  const parallel = async (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((t) => t()));
  const phase = () => {};
  const log = () => {};

  const fn = new AsyncFunction("args", "agent", "parallel", "phase", "log", SRC);
  const out = (await fn(args, agent, parallel, phase, log)) ?? {};
  return { ...(out as object), agentCalls } as Run;
}

describe("build-flow runner input handling", () => {
  it("blocks (not silently 'done') when args carries no batches", async () => {
    const r = await runRunner({ ledger: { decisions: [], conventions: [], deviations: [] } });
    expect(r.agentCalls).toBe(0);
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/batch/i);
  });

  it("blocks when args is a JSON string that parses to no batches", async () => {
    const r = await runRunner(JSON.stringify({ startBatch: 0, batches: [] }));
    expect(r.agentCalls).toBe(0);
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/batch/i);
  });

  it("blocks with a clear reason when args is a non-JSON string", async () => {
    const r = await runRunner("not valid json {");
    expect(r.agentCalls).toBe(0);
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/json|string|object/i);
  });

  it("normalizes a JSON-string args and runs the parsed batch", async () => {
    const args = JSON.stringify({
      batches: [[{ id: "t1", title: "T1", prompt: "implement the resource group" }]],
    });
    let seen = "";
    const r = await runRunner(args, async (prompt) => {
      seen = prompt;
      return { needsHumanInput: { reason: "halt for test" } }; // stop after first agent
    });
    expect(r.agentCalls).toBe(1);
    expect(seen).toContain("implement the resource group");
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("halt for test");
  });
});

// --- Execution-flow tests -------------------------------------------------
// These drive the runner through real batch/review/fix control flow by scripting
// agent() responses per role. Roles are identified by the runner's own prompt text,
// so the tests break if those prompts drift in a way that changes the contract.

type Role = "impl" | "spec" | "quality" | "fix" | "recheck" | "verify" | "verify-fix" | "unknown";
const roleOf = (p: string): Role =>
  p.includes("You are implementing ONE task") ? "impl"
  : p.includes("spec-compliance reviewer") ? "spec"
  : p.includes("code-quality reviewer") ? "quality"
  : p.includes("Reviewers found issues") ? "fix"
  : p.includes("A fix agent just addressed") ? "recheck"
  : p.includes("Final verification for the whole run") ? "verify"
  : p.includes("full-suite verification failed") ? "verify-fix"
  : "unknown";

interface Call { role: Role; prompt: string; opts?: AgentOpts }

// respond(role, ctx) returns the scripted agent result. ctx.occurrence is the 0-based
// index of THIS role's call (so review round N == the Nth spec/quality call).
type Respond = (
  role: Role,
  ctx: { prompt: string; opts?: AgentOpts; occurrence: number; calls: Call[] },
) => unknown;

async function runFlow(args: unknown, respond: Respond): Promise<Run & { calls: Call[] }> {
  const calls: Call[] = [];
  const r = await runRunner(args, async (prompt, opts) => {
    const role = roleOf(prompt);
    calls.push({ role, prompt, opts });
    const occurrence = calls.filter((c) => c.role === role).length - 1;
    return respond(role, { prompt, opts, occurrence, calls });
  });
  return { ...r, calls };
}

const clean = { approved: true, findings: [] };
const impl = { summary: "done", filesTouched: ["x.ts"], testsPassed: true };
const verified = { passed: true, summary: "all tests pass, lint clean" };
const allClean: Respond = (role) =>
  role === "impl" || role === "fix" || role === "verify-fix" ? impl
  : role === "verify" ? verified
  : clean;

// Use a distinctive marker in the prompt so tests can identify which task ran without
// colliding with the runner's own template prose (e.g. "implement and test only").
const task = (id: string) => ({ id, title: id.toUpperCase(), prompt: `TASKMARK:${id}` });

describe("build-flow runner execution flow", () => {
  it("runs a clean single batch to done and records it in the ledger", async () => {
    const ledger = { decisions: [], conventions: [], deviations: [] };
    const r = await runFlow({ batches: [[task("a")]], ledger }, allClean);

    expect(r.status).toBe("done");
    expect(r.results).toHaveLength(1);
    expect(r.calls.map((c) => c.role)).toEqual(["impl", "spec", "quality", "verify"]);
    expect(r.ledger?.decisions).toHaveLength(2);
    expect(r.ledger?.decisions[0]).toMatch(/reviewed clean/i);
    expect(r.ledger?.decisions[1]).toMatch(/verification/i);
  });

  it("implements batches in dependency order", async () => {
    const r = await runFlow({ batches: [[task("a")], [task("b")]] }, allClean);

    expect(r.status).toBe("done");
    const implTasks = r.calls
      .filter((c) => c.role === "impl")
      .map((c) => c.prompt.match(/TASKMARK:(\w)/)?.[1]);
    expect(implTasks).toEqual(["a", "b"]);
  });

  it("resumes at startBatch, skipping earlier batches", async () => {
    const r = await runFlow({ batches: [[task("a")], [task("b")]], startBatch: 1 }, allClean);

    expect(r.status).toBe("done");
    const implPrompts = r.calls.filter((c) => c.role === "impl").map((c) => c.prompt);
    expect(implPrompts.some((p) => p.includes("TASKMARK:a"))).toBe(false);
    expect(implPrompts.some((p) => p.includes("TASKMARK:b"))).toBe(true);
  });

  it("runs one fix round with a scoped re-check — never a second full review", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, (role) => {
      if (role === "impl" || role === "fix") return impl;
      if (role === "verify") return verified;
      if (role === "spec")
        return { approved: false, findings: [{ severity: "critical", issue: "bug" }] };
      return clean; // quality clean; recheck clean -> converges
    });

    expect(r.status).toBe("done");
    expect(r.calls.filter((c) => c.role === "fix")).toHaveLength(1);
    // The full reviewers run exactly once; convergence is proven by the scoped recheck.
    expect(r.calls.filter((c) => c.role === "spec")).toHaveLength(1);
    expect(r.calls.filter((c) => c.role === "quality")).toHaveLength(1);
    expect(r.calls.filter((c) => c.role === "recheck")).toHaveLength(1);
    expect(r.calls.find((c) => c.role === "recheck")?.opts?.agentType).toBe("kit:kit-worker");
  });

  it("blocks when recheck findings never converge within maxFixRounds", async () => {
    const dirty = { approved: false, findings: [{ severity: "important", issue: "still broken" }] };
    const r = await runFlow(
      { batches: [[task("a")]], maxFixRounds: 2 },
      (role) =>
        role === "impl" || role === "fix" ? impl
        : role === "spec" || role === "recheck" ? dirty
        : role === "verify" ? verified
        : clean,
    );

    expect(r.status).toBe("blocked");
    expect(r.blockedAtBatch).toBe(0);
    expect(r.reason).toMatch(/unresolved/i);
    expect(r.findings?.length).toBeGreaterThan(0);
  });

  it("escalates the fix agent from kit-worker to kit-arbiter on the final round", async () => {
    const dirty = { approved: false, findings: [{ severity: "critical", issue: "x" }] };
    const r = await runFlow(
      { batches: [[task("a")]], maxFixRounds: 2 },
      (role) =>
        role === "impl" || role === "fix" ? impl
        : role === "spec" || role === "recheck" ? dirty
        : role === "verify" ? verified
        : clean,
    );

    const fixAgents = r.calls.filter((c) => c.role === "fix").map((c) => c.opts?.agentType);
    expect(fixAgents).toEqual(["kit:kit-worker", "kit:kit-arbiter"]);
  });

  it("escalates the quality review to opus only on the final batch", async () => {
    const r = await runFlow({ batches: [[task("a")], [task("b")]] }, allClean);

    expect(r.status).toBe("done");
    const quality = r.calls.filter((c) => c.role === "quality");
    expect(quality.map((c) => c.opts?.agentType)).toEqual(["kit:kit-worker", "kit:kit-arbiter"]);
  });

  it("names an agent on every call and never sets a model or effort", async () => {
    const r = await runFlow({ batches: [[task("a")], [task("b")]] }, allClean);

    expect(r.calls.length).toBeGreaterThan(0);
    for (const c of r.calls) {
      expect(c.opts?.agentType).toBeTruthy();
      expect(c.opts).not.toHaveProperty("model");
      expect(c.opts).not.toHaveProperty("effort");
    }
  });

  it("runs the final verification once and dispatches a verify-fix on failure", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, (role, { occurrence }) => {
      if (role === "verify")
        return occurrence === 0
          ? { passed: false, summary: "1 test failing", failures: [{ check: "t1", detail: "x != y" }] }
          : verified;
      return allClean(role, { prompt: "", occurrence, calls: [] });
    });

    expect(r.status).toBe("done");
    expect(r.calls.filter((c) => c.role === "verify")).toHaveLength(2);
    expect(r.calls.filter((c) => c.role === "verify-fix")).toHaveLength(1);
    expect((r as Run & { verification?: { passed: boolean } }).verification?.passed).toBe(true);
  });

  it("stamps every agent prompt with the worktree header when args.worktree is set", async () => {
    const r = await runFlow(
      { batches: [[task("a")]], worktree: "/repo/.worktrees/st-test" },
      (role) => {
        if (role === "spec")
          return { approved: false, findings: [{ severity: "critical", issue: "x" }] };
        return allClean(role, { prompt: "", occurrence: 0, calls: [] });
      },
    );

    expect(r.status).toBe("done");
    // impl, spec, quality, fix, recheck, verify all ran — every one carries the path
    const roles = new Set(r.calls.map((c) => c.role));
    expect(roles).toEqual(new Set(["impl", "spec", "quality", "fix", "recheck", "verify"]));
    expect(r.calls.every((c) => c.prompt.includes("/repo/.worktrees/st-test"))).toBe(true);
  });

  it("omits the worktree header when args.worktree is not set", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, allClean);
    expect(r.calls.every((c) => !c.prompt.includes("## Worktree"))).toBe(true);
  });

  it("blocks when the final verification never converges", async () => {
    const failing = { passed: false, summary: "still failing", failures: [{ check: "t1", detail: "x != y" }] };
    const r = await runFlow({ batches: [[task("a")]] }, (role) =>
      role === "verify" ? failing : allClean(role, { prompt: "", occurrence: 0, calls: [] }),
    );

    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/verification/i);
  });

  it("blocks immediately when an implementer needs human input, before any review", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, (role) =>
      role === "impl" ? { needsHumanInput: { reason: "task is ambiguous" } } : impl,
    );

    expect(r.status).toBe("blocked");
    expect(r.blockedAtBatch).toBe(0);
    expect(r.reason).toBe("task is ambiguous");
    expect(r.calls.every((c) => c.role === "impl")).toBe(true);
  });

  it("blocks (not crashes) when a batch is an object instead of a task array", async () => {
    // The failure we observed in the wild: an agent shapes a batch as
    // { index, tasks: [...] } instead of a bare array of tasks.
    const r = await runFlow(
      { batches: [{ index: 0, tasks: [task("a")] }] },
      allClean,
    );

    expect(r.agentCalls).toBe(0);
    expect(r.status).toBe("blocked");
    expect(r.blockedAtBatch).toBe(0);
    expect(r.reason).toMatch(/array/i);
  });
});

// The Workflow runtime resolves agent() to null when the agent was stopped in /workflows or
// hit an unrecoverable API error. Every stage must turn that into `blocked` naming the agent;
// reading null as "no findings" / "no failures" is the silent fake-done this file exists to
// prevent. One row per distinct call site (sequential impl, the parallel review pair, both
// fix-loop stages, both verify-loop stages).
describe("build-flow runner: a null agent() result blocks instead of passing", () => {
  const dirty = { approved: false, findings: [{ severity: "critical", issue: "x" }] };
  const failing = { passed: false, summary: "1 failing", failures: [{ check: "t1", detail: "x != y" }] };
  // Drive every stage: spec dirty -> fix -> recheck clean; verify fails once -> verify-fix -> verify ok.
  const full: Respond = (role, ctx) =>
    role === "spec" ? dirty
    : role === "verify" ? (ctx.occurrence === 0 ? failing : verified)
    : allClean(role, ctx);

  it.each([
    ["impl", "impl:b"],
    ["quality", "quality:b1"],
    ["fix", "fix:b1:r1"],
    ["recheck", "recheck:b1:r1"],
    ["verify", "verify:r1"],
    ["verify-fix", "verify-fix:r1"],
  ] as Array<[Role, string]>)("%s returning null blocks naming %s", async (nullRole, label) => {
    const r = await runFlow({ batches: [[task("a"), task("b")]] }, (role, ctx) => {
      if (role !== nullRole) return full(role, ctx);
      // For impl, only the SECOND task dies, proving the first task's result is kept.
      return nullRole === "impl" && !ctx.prompt.includes("TASKMARK:b") ? impl : null;
    });

    expect(r.status).toBe("blocked");
    expect(r.blockedAtBatch).toBe(0);
    expect(r.reason).toContain(label);
    expect(r.reason).toMatch(/did not complete/i);
    expect(r.reason).toContain("report this to the user and wait for direction");
    expect(r.ledger).toBeDefined();
  });

  it("keeps the finished task's result and spawns no reviewer when an implementer dies", async () => {
    const r = await runFlow({ batches: [[task("a"), task("b")]] }, (role, ctx) =>
      role === "impl" ? (ctx.prompt.includes("TASKMARK:b") ? null : impl) : allClean(role, ctx),
    );
    expect(r.status).toBe("blocked");
    expect(r.results).toHaveLength(1);
    expect(r.calls.map((c) => c.role)).toEqual(["impl", "impl"]);
  });

  it("never reports done when the verifier dies, even with every batch clean", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, (role, ctx) => (role === "verify" ? null : allClean(role, ctx)));
    expect(r.status).toBe("blocked");
    expect((r as Run & { verification?: unknown }).verification).toBeUndefined();
    expect(r.ledger?.decisions.some((d) => /verifier returned no result/i.test(d))).toBe(false);
  });
});
