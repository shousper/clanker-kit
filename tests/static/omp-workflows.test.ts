import { describe, it, expect } from "bun:test";
import { run as runBuildFlow } from "../../plugins/kit-omp/skills/build-flow/build.workflow.mjs";
import { run as runCodeReview } from "../../plugins/kit-omp/skills/code-review/review.workflow.mjs";

// Exercises the OMP workflow modules against a fake of the eval kernel's contract as it is
// TODAY (verified 2026-09-05 against omp 18.1.10): `agent(prompt, { agent, label, schema })`
// returns a handle at once; `await handle.wait({ timeout })` (SECONDS, in an options object)
// yields the result, or rejects when the agent failed, yielded off-schema, was cancelled, or
// exceeded the timeout (TimeoutError); there is no `parallel()`. The modules bind these as
// globals; tests inject them through run()'s second parameter.

type AgentOpts = { agent?: string; label?: string; schema?: unknown };
type WaitOpts = { timeout?: number } | undefined;

interface Handle {
  id: string;
  wait: (opts?: WaitOpts) => Promise<unknown>;
  cancel: () => Promise<void>;
  status: () => unknown;
}

/** Sentinel a responder returns to simulate an agent that never finishes: the fake handle's
 *  wait() then rejects with a TimeoutError, the way OMP does once the timeout elapses. */
const HANGS = Symbol("hangs");

type Respond = (prompt: string, opts: AgentOpts) => unknown;

interface FakeHost {
  agent: (prompt: string, opts?: AgentOpts) => Promise<Handle>;
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<string>;
  files: Map<string, string>;
  spawned: string[];
  cancelled: string[];
  waitOpts: WaitOpts[];
}

const ALLOWED_AGENTS: Record<string, true> = { "kit-worker": true, "kit-arbiter": true, "kit-verifier": true };

/** Every spawn must name a real OMP agent, carry a hyphenated label (':' is the selector
 *  separator in agent:// URLs, and the label becomes the id), and never leak model/effort. */
function assertOmpCallShape(opts?: AgentOpts): void {
  expect(opts?.agent).toBeDefined();
  expect(ALLOWED_AGENTS[opts!.agent as string]).toBe(true);
  expect(typeof opts?.label).toBe("string");
  expect(opts!.label).not.toContain(":");
  expect(opts).not.toHaveProperty("model");
  expect(opts).not.toHaveProperty("effort");
}

function fakeHost(respond: Respond, files = new Map<string, string>()): FakeHost {
  const spawned: string[] = [];
  const cancelled: string[] = [];
  const waitOpts: WaitOpts[] = [];
  const labelUses = new Map<string, number>();
  return {
    files,
    spawned,
    cancelled,
    waitOpts,
    agent: async (prompt, opts = {}) => {
      assertOmpCallShape(opts);
      // OMP uniquifies a reused label with a numeric suffix (`impl-T1-2`); mirror it so a
      // handle id that differs from its label is exercised.
      const uses = (labelUses.get(opts.label!) ?? 0) + 1;
      labelUses.set(opts.label!, uses);
      const id = uses === 1 ? opts.label! : `${opts.label}-${uses}`;
      spawned.push(id);
      const outcome = Promise.resolve().then(() => respond(prompt, opts));
      outcome.catch(() => {}); // surfaced through wait(); never an unhandled rejection
      return {
        id,
        wait: async (o) => {
          waitOpts.push(o);
          const value = await outcome;
          if (value === HANGS) {
            throw Object.assign(new Error(`agent handle ${id} is still running`), { name: "TimeoutError" });
          }
          return value;
        },
        cancel: async () => {
          cancelled.push(id);
        },
        status: () => ({}),
      };
    },
    read: async (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      return files.get(path)!;
    },
    write: async (path, content) => {
      files.set(path, content);
      return path;
    },
  };
}

type Run = {
  status?: string;
  reason?: string;
  blockedAtBatch?: number;
  results?: unknown[];
  findings?: Array<{ severity: string; issue: string }>;
  ledger?: { decisions: string[]; conventions: string[]; deviations: string[] };
  verification?: { passed: boolean };
  host: FakeHost;
};

// By default any agent() call is a failure, which proves the guards return BEFORE doing work.
async function runRunner(args: unknown, respond?: Respond, files?: Map<string, string>): Promise<Run> {
  const host = fakeHost(
    respond ??
      (() => {
        throw new Error("agent() must not run when there are no batches to build");
      }),
    files,
  );
  const out = (await runBuildFlow(args, host)) ?? {};
  return { ...(out as object), host } as Run;
}

const emptyLedger = () => ({ decisions: [], conventions: [], deviations: [] });
const task = (id: string) => ({ id, title: id.toUpperCase(), prompt: `TASKMARK:${id}` });

describe("build-flow OMP runner: harness contract", () => {
  it("blocks before spawning when called with the retired run(host, args) shape", async () => {
    let called = 0;
    const legacyHost = {
      agent: async () => {
        called++;
        return {};
      },
      parallel: async () => [],
      phase: () => {},
      log: () => {},
    };
    const r = (await runBuildFlow(legacyHost, { batches: [[task("a")]] })) as Run;
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/one argument|host object/i);
    expect(called).toBe(0);
  });

  it("blocks before spawning when no agent() global exists (run outside an eval cell)", async () => {
    const r = (await runBuildFlow({ batches: [[task("a")]] }, { agent: undefined })) as Run;
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/eval/i);
  });
});

describe("build-flow OMP runner: input handling", () => {
  it("blocks (not silently 'done') when args carries no batches", async () => {
    const r = await runRunner({ ledger: emptyLedger() });
    expect(r.host.spawned).toHaveLength(0);
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/batch/i);
  });

  it("blocks loudly (not silently 'done') on zero batches from a JSON-string args", async () => {
    const r = await runRunner(JSON.stringify({ startBatch: 0, batches: [] }));
    expect(r.host.spawned).toHaveLength(0);
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/batch/i);
  });

  it("normalizes a JSON-string args and runs the parsed batch", async () => {
    const args = JSON.stringify({
      batches: [[{ id: "t1", title: "T1", prompt: "implement the resource group" }]],
    });
    let seen = "";
    const r = await runRunner(args, (prompt) => {
      seen = prompt;
      return { needsHumanInput: { reason: "halt for test" } }; // stop after first agent
    });
    expect(r.host.spawned).toEqual(["impl-t1"]);
    expect(seen).toContain("implement the resource group");
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("halt for test");
  });

  it("blocks (not crashes) when a batch is an object instead of a task array", async () => {
    const r = await runRunner({ batches: [{ index: 0, tasks: [task("a")] }] });
    expect(r.host.spawned).toHaveLength(0);
    expect(r.status).toBe("blocked");
    expect(r.blockedAtBatch).toBe(0);
    expect(r.reason).toMatch(/array/i);
  });
});

// --- Execution-flow tests -------------------------------------------------
// Roles are identified by the runner's own prompt text, so these break if the prompts
// drift in a way that changes the contract.

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

type RoleRespond = (
  role: Role,
  ctx: { prompt: string; opts?: AgentOpts; occurrence: number; calls: Call[] },
) => unknown;

async function runFlow(args: unknown, respond: RoleRespond, files?: Map<string, string>): Promise<Run & { calls: Call[] }> {
  const calls: Call[] = [];
  const r = await runRunner(
    args,
    (prompt, opts) => {
      const role = roleOf(prompt);
      calls.push({ role, prompt, opts });
      const occurrence = calls.filter((c) => c.role === role).length - 1;
      return respond(role, { prompt, opts, occurrence, calls });
    },
    files,
  );
  return { ...r, calls };
}

const clean = { approved: true, findings: [] };
const impl = { summary: "done", filesTouched: ["x.ts"], testsPassed: true };
const verified = { passed: true, summary: "all tests pass, lint clean" };
const allClean: RoleRespond = (role) =>
  role === "impl" || role === "fix" || role === "verify-fix" ? impl
  : role === "verify" ? verified
  : clean;

describe("build-flow OMP runner: execution flow", () => {
  it("reaches status: 'done' on a clean pass and records it in the ledger", async () => {
    const r = await runFlow({ batches: [[task("a")]], ledger: emptyLedger() }, allClean);

    expect(r.status).toBe("done");
    expect(r.results).toHaveLength(1);
    expect(r.calls.map((c) => c.role)).toEqual(["impl", "spec", "quality", "verify"]);
    expect(r.host.spawned).toEqual(["impl-a", "spec-b1", "quality-b1", "verify-r1"]);
    expect(r.ledger?.decisions).toHaveLength(2);
    expect(r.ledger?.decisions[0]).toMatch(/reviewed clean/i);
    expect(r.ledger?.decisions[1]).toMatch(/verification/i);
  });

  it(
    "spawns the spec and quality reviews concurrently",
    async () => {
      let releaseSpec!: () => void;
      const specGate = new Promise<void>((resolve) => {
        releaseSpec = resolve;
      });
      // If the runner awaited spec before spawning quality, spec would wait on the gate
      // forever and this test would time out instead of passing.
      const r = await runFlow({ batches: [[task("a")]] }, async (role, ctx) => {
        if (role === "spec") {
          await specGate;
          return clean;
        }
        if (role === "quality") {
          releaseSpec();
          return clean;
        }
        return allClean(role, ctx);
      });
      expect(r.status).toBe("done");
    },
    3_000,
  );

  it("returns blocked with blockedAtBatch when recheck findings never converge within maxFixRounds", async () => {
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

  it("escalates the fix agent from kit-worker to kit-arbiter on the final fix round", async () => {
    const dirty = { approved: false, findings: [{ severity: "critical", issue: "x" }] };
    const r = await runFlow(
      { batches: [[task("a")]], maxFixRounds: 2 },
      (role) =>
        role === "impl" || role === "fix" ? impl
        : role === "spec" || role === "recheck" ? dirty
        : role === "verify" ? verified
        : clean,
    );

    const fixAgents = r.calls.filter((c) => c.role === "fix").map((c) => c.opts?.agent);
    expect(fixAgents).toEqual(["kit-worker", "kit-arbiter"]);
    expect(r.host.spawned).toContain("fix-b1-r1");
    expect(r.host.spawned).toContain("recheck-b1-r2");
  });

  it("escalates the quality review to kit-arbiter only on the final batch", async () => {
    const r = await runFlow({ batches: [[task("a")], [task("b")]] }, allClean);

    expect(r.status).toBe("done");
    const quality = r.calls.filter((c) => c.role === "quality");
    expect(quality.map((c) => c.opts?.agent)).toEqual(["kit-worker", "kit-arbiter"]);
  });

  it("runs final verification on kit-verifier and dispatches a kit-worker verify-fix on failure", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, (role, ctx) => {
      if (role === "verify")
        return ctx.occurrence === 0
          ? { passed: false, summary: "1 test failing", failures: [{ check: "t1", detail: "x != y" }] }
          : verified;
      return allClean(role, ctx);
    });

    expect(r.status).toBe("done");
    const verifyCalls = r.calls.filter((c) => c.role === "verify");
    expect(verifyCalls).toHaveLength(2);
    expect(verifyCalls.every((c) => c.opts?.agent === "kit-verifier")).toBe(true);
    const verifyFix = r.calls.filter((c) => c.role === "verify-fix");
    expect(verifyFix.map((c) => c.opts?.agent)).toEqual(["kit-worker"]);
    expect(r.verification?.passed).toBe(true);
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

  it("observes ONLY kit-worker/kit-arbiter/kit-verifier agent names, never model/effort, across a full run", async () => {
    const r = await runFlow({ batches: [[task("a")], [task("b")]] }, allClean);

    expect(r.status).toBe("done");
    expect(r.calls.length).toBeGreaterThan(0);
    for (const call of r.calls) {
      expect(ALLOWED_AGENTS[call.opts?.agent as string]).toBe(true);
      expect(call.opts).not.toHaveProperty("model");
      expect(call.opts).not.toHaveProperty("effort");
    }
  });
});

describe("build-flow OMP runner: stage failures never throw or hang", () => {
  it("a provider refusal blocks with advice to report to the user, not to reroute", async () => {
    const r = await runFlow({ batches: [[task("a")]] }, (role, ctx) => {
      if (role === "impl") throw new Error('[anthropic/claude-sonnet-5] 429 {"type":"rate_limit_error"} retry-after-ms=63061000');
      return allClean(role, ctx);
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("429");
    expect(r.reason).toContain("The model provider refused the request. Report this to the user and wait for direction");
  });

  it("a rejecting wait() blocks with the agent id and keeps results and ledger", async () => {
    const r = await runFlow({ batches: [[task("a"), task("b")]] }, (role, ctx) => {
      if (role === "impl" && ctx.prompt.includes("TASKMARK:b")) throw new Error("schema_violation: missing required fields");
      return allClean(role, ctx);
    });

    expect(r.status).toBe("blocked");
    expect(r.blockedAtBatch).toBe(0);
    expect(r.reason).toContain("impl-b");
    expect(r.reason).toContain("schema_violation");
    expect(r.reason).toContain("history://impl-b");
    expect(r.results).toHaveLength(1);
    expect(r.ledger).toBeDefined();
    expect(r.host.cancelled).toEqual(["impl-b"]);
    expect(r.calls.map((c) => c.role)).toEqual(["impl", "impl"]);
  });

  it("a stage exceeding stageTimeoutMinutes is cancelled and blocks naming the agent; the timeout reaches wait() in seconds", async () => {
    const r = await runFlow({ batches: [[task("a")]], stageTimeoutMinutes: 2 }, (role, ctx) =>
      role === "spec" ? HANGS : allClean(role, ctx),
    );

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("spec-b1");
    expect(r.reason).toMatch(/2 min/);
    expect(r.host.cancelled).toEqual(["spec-b1"]);
    // A bare number is ignored by OMP; the options object with SECONDS is the contract.
    expect(r.host.waitOpts.every((o) => o !== undefined && typeof o === "object")).toBe(true);
    expect(r.host.waitOpts[0]).toEqual({ timeout: 120 });
  });

  it("names the harness-assigned id (not the label) when a reused label was suffixed", async () => {
    const host = fakeHost((prompt) => {
      if (prompt.includes("TASKMARK:a") && prompt.includes("You are implementing ONE task")) {
        return host.spawned.length === 1
          ? { needsHumanInput: { reason: "first run stops" } }
          : Promise.reject(new Error("second run fails"));
      }
      return clean;
    });
    const first = (await runBuildFlow({ batches: [[task("a")]] }, host)) as Run;
    expect(first.reason).toBe("first run stops");
    const second = (await runBuildFlow({ batches: [[task("a")]] }, host)) as Run;
    expect(host.spawned).toEqual(["impl-a", "impl-a-2"]);
    expect(second.status).toBe("blocked");
    expect(second.reason).toContain("impl-a-2");
  });
});

describe("build-flow OMP runner: journal and resume", () => {
  const STATE = "local://build-flow/demo.state.json";

  it("journals finished stages under local://build-flow/<slug>.state.json and replays them on relaunch", async () => {
    const files = new Map<string, string>();
    const first = await runFlow(
      { slug: "demo", batches: [[task("a")], [task("b")]] },
      (role, ctx) => (role === "verify" ? HANGS : allClean(role, ctx)),
      files,
    );
    expect(first.status).toBe("blocked");
    expect(first.blockedAtBatch).toBe(1);
    expect(first.reason).toContain("demo-verify-r1");

    const state = JSON.parse(files.get(STATE)!);
    expect(state.status).toBe("blocked");
    expect(Object.keys(state.stages).sort()).toEqual(
      ["impl-a", "impl-b", "quality-b1", "quality-b2", "spec-b1", "spec-b2"],
    );

    const second = await runFlow({ slug: "demo", batches: [[task("a")], [task("b")]] }, allClean, files);
    expect(second.status).toBe("done");
    expect(second.host.spawned).toEqual(["demo-verify-r1"]);
    expect(second.results).toHaveLength(2);
    expect(second.ledger?.decisions).toHaveLength(3);
    expect(JSON.parse(files.get(STATE)!).status).toBe("done");
  });

  it("re-runs a blocked batch on relaunch while earlier batches replay", async () => {
    const files = new Map<string, string>();
    const first = await runFlow(
      { slug: "demo", batches: [[task("a")], [task("b")]] },
      (role, ctx) =>
        role === "impl" && ctx.prompt.includes("TASKMARK:b") ? { needsHumanInput: { reason: "b is ambiguous" } } : allClean(role, ctx),
      files,
    );
    expect(first.status).toBe("blocked");
    expect(first.blockedAtBatch).toBe(1);
    expect(Object.keys(JSON.parse(files.get(STATE)!).stages).sort()).toEqual(["impl-a", "quality-b1", "spec-b1"]);

    const second = await runFlow({ slug: "demo", batches: [[task("a")], [task("b")]] }, allClean, files);
    expect(second.status).toBe("done");
    expect(second.host.spawned).toEqual(["demo-impl-b", "demo-spec-b2", "demo-quality-b2", "demo-verify-r1"]);
  });

  it("does not duplicate ledger decisions when a verify-phase block is relaunched with the returned ledger", async () => {
    // Observed live: blockedAtBatch points at the LAST batch after a verify-phase block, so
    // `startBatch = blockedAtBatch` + the returned ledger replays that batch from the journal
    // and would record its decision a second time.
    const files = new Map<string, string>();
    const first = await runFlow(
      { slug: "demo", batches: [[task("a")], [task("b")]] },
      (role, ctx) => (role === "verify" ? HANGS : allClean(role, ctx)),
      files,
    );
    expect(first.status).toBe("blocked");
    expect(first.blockedAtBatch).toBe(1);
    expect(first.ledger?.decisions).toHaveLength(2);

    const second = await runFlow(
      { slug: "demo", batches: [[task("a")], [task("b")]], startBatch: first.blockedAtBatch, ledger: first.ledger },
      allClean,
      files,
    );
    expect(second.status).toBe("done");
    expect(second.host.spawned).toEqual(["demo-verify-r1"]);
    expect(second.ledger?.decisions).toEqual([
      expect.stringMatching(/^Batch 1 \(a\)/),
      expect.stringMatching(/^Batch 2 \(b\)/),
      expect.stringMatching(/^Final verification/),
    ]);
  });

  it("never replays a run that finished 'done'", async () => {
    const files = new Map<string, string>();
    const first = await runFlow({ slug: "demo", batches: [[task("a")]] }, allClean, files);
    expect(first.status).toBe("done");
    const second = await runFlow({ slug: "demo", batches: [[task("a")]] }, allClean, files);
    // Agent ids carry the slug (session-wide uniqueness); journal keys do not.
    expect(second.host.spawned).toEqual(["demo-impl-a", "demo-spec-b1", "demo-quality-b1", "demo-verify-r1"]);
  });

  it("journals nothing without a slug", async () => {
    const files = new Map<string, string>();
    const r = await runFlow({ batches: [[task("a")]] }, allClean, files);
    expect(r.status).toBe("done");
    expect(files.size).toBe(0);
  });
});

// --- Code-review workflow -------------------------------------------------

describe("code-review OMP runner", () => {
  const reviewRespond: Respond = (prompt) => {
    if (prompt.startsWith("Review the diff")) {
      if (prompt.includes('"correctness"')) {
        return { findings: [{ severity: "critical", issue: "off-by-one", file: "a.ts", line: 5 }] };
      }
      if (prompt.includes('"quality"')) {
        return { findings: [{ severity: "minor", issue: "unverified nit" }] };
      }
      return { findings: [] };
    }
    if (prompt.startsWith("Adversarially check")) {
      return { real: prompt.includes("off-by-one") };
    }
    throw new Error(`unexpected prompt: ${prompt}`);
  };

  it("returns { status, diffRef, findings }: fans dimensions to kit-worker (kit-arbiter for architecture) and keeps only verified findings", async () => {
    const host = fakeHost(reviewRespond);
    const result = (await runCodeReview({ diffRef: "main" }, host)) as {
      status: string;
      diffRef: string;
      findings: Array<{ dimension: string; verified: boolean }>;
    };

    expect(result.status).toBe("done");
    expect(result.diffRef).toBe("main");
    expect(result.findings).toEqual([
      { severity: "critical", issue: "off-by-one", file: "a.ts", line: 5, dimension: "correctness", verified: true },
    ]);
    expect(host.spawned.slice(0, 5)).toEqual([
      "review-correctness", "review-quality", "review-tests", "review-security", "review-architecture",
    ]);
  });

  it("drops unverified findings and defaults diffRef to main", async () => {
    const host = fakeHost((prompt) => {
      if (prompt.startsWith("Review the diff")) return { findings: [{ severity: "minor", issue: "nit" }] };
      if (prompt.startsWith("Adversarially check")) return { real: false };
      throw new Error("unexpected prompt");
    });
    const result = (await runCodeReview({}, host)) as { status: string; diffRef: string; findings: unknown[] };

    expect(result.status).toBe("done");
    expect(result.diffRef).toBe("main");
    expect(result.findings).toEqual([]);
  });

  it("reports 'partial' naming the failed agent when a dimension does not complete, keeping the other verified findings", async () => {
    const host = fakeHost((prompt, opts) => {
      if (opts.label === "review-correctness") throw new Error("provider 429");
      if (prompt.startsWith("Review the diff")) {
        return prompt.includes('"quality"') ? { findings: [{ severity: "important", issue: "leaks a handle" }] } : { findings: [] };
      }
      return { real: true };
    });
    const result = (await runCodeReview({ diffRef: "HEAD" }, host)) as {
      status: string;
      findings: Array<{ issue: string }>;
      failed: Array<{ id: string; error: string }>;
    };

    expect(result.status).toBe("partial");
    expect(result.failed).toEqual([{
      id: "review-correctness",
      error: "provider 429. The model provider refused the request. Report this to the user and wait for direction.",
    }]);
    expect(result.findings.map((f) => f.issue)).toEqual(["leaks a handle"]);
    expect(host.cancelled).toEqual(["review-correctness"]);
  });

  it("reports the ids actually spawned in `agents`, and a slug keeps a second review in the same session from colliding", async () => {
    type Result = { status: string; agents: Record<string, string> };
    const host = fakeHost(reviewRespond);
    const first = (await runCodeReview({ diffRef: "main" }, host)) as Result;
    expect(first.agents["review-correctness"]).toBe("review-correctness");
    expect(first.agents["verify-correctness-1"]).toBe("verify-correctness-1");

    // Same host, bare labels again: the runtime uniquifies, and `agents` says so.
    const second = (await runCodeReview({ diffRef: "main" }, host)) as Result;
    expect(second.agents["review-correctness"]).toBe("review-correctness-2");

    // A slug namespaces every label, so nothing collides and the map is the identity.
    const scoped = (await runCodeReview({ diffRef: "main", slug: "delta.1" }, host)) as Result;
    expect(Object.keys(scoped.agents)).toEqual([
      "delta.1-review-correctness", "delta.1-review-quality", "delta.1-review-tests", "delta.1-review-security", "delta.1-review-architecture",
      "delta.1-verify-correctness-1", "delta.1-verify-quality-2",
    ]);
    expect(Object.entries(scoped.agents).every(([label, id]) => label === id)).toBe(true);
    expect(scoped.status).toBe("done");
  });

  it("blocks before spawning when called with the retired run(host, args) shape", async () => {
    let called = 0;
    const result = (await runCodeReview({ agent: async () => { called++; }, parallel: async () => [] }, {})) as { status: string; reason: string };
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/one argument|host object/i);
    expect(called).toBe(0);
  });
});
