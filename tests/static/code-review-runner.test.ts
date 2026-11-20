import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { KIT_CLAUDE_ROOT } from "../utils/paths";

// Drives the Claude code-review runner the same way build-flow-runner.test.ts drives the
// batch runner: compiled into an AsyncFunction with the Workflow runtime's globals faked.
// The runtime resolves agent() to null when an agent is stopped or hits an unrecoverable API
// error; a dead reviewer must surface as `partial`, and a finding whose verifier died must be
// reported as unverified rather than silently counted as a false positive.

const SRC = readFileSync(
  resolve(KIT_CLAUDE_ROOT, "skills", "code-review", "review.workflow.js"),
  "utf-8",
).replace("export const meta", "const meta");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<any>;

type AgentOpts = { label?: string; phase?: string; agentType?: string; model?: string; effort?: string; schema?: unknown };
type Respond = (prompt: string, opts: AgentOpts) => unknown;

interface Review {
  status: string;
  diffRef: string;
  findings: Array<{ issue: string; dimension: string; verified: boolean }>;
  unverified?: Array<{ issue: string; dimension: string }>;
  failed?: Array<{ id: string; error: string }>;
  labels: string[];
}

async function runReview(args: unknown, respond: Respond): Promise<Review> {
  const labels: string[] = [];
  const agent = async (prompt: string, opts: AgentOpts = {}) => {
    labels.push(opts.label ?? "?");
    return respond(prompt, opts);
  };
  const parallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()));
  // pipeline(items, ...stages): each item flows through every stage; stage N receives the
  // previous stage's value and the item. A null from agent() stays in place.
  const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown) => unknown>) =>
    Promise.all(
      items.map(async (item) => {
        let value: unknown = item;
        for (const [i, stage] of stages.entries()) value = await (i === 0 ? stage(item, item) : stage(value, item));
        return value;
      }),
    );
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", SRC);
  const out = (await fn(args, agent, parallel, pipeline, () => {}, () => {})) ?? {};
  return { ...(out as object), labels } as Review;
}

const isReview = (p: string) => p.startsWith("Review the diff");
const isVerdict = (p: string) => p.startsWith("Adversarially check");

const oneRealFinding: Respond = (prompt) => {
  if (isReview(prompt)) {
    return prompt.includes('"correctness"')
      ? { findings: [{ severity: "critical", issue: "off-by-one", file: "a.ts", line: 5 }] }
      : { findings: [] };
  }
  if (isVerdict(prompt)) return { real: true };
  throw new Error(`unexpected prompt: ${prompt}`);
};

describe("code-review runner", () => {
  it("returns done with only verified findings when every agent completes", async () => {
    const r = await runReview({ diffRef: "main" }, oneRealFinding);
    expect(r.status).toBe("done");
    expect(r.diffRef).toBe("main");
    expect(r.findings.map((f) => f.issue)).toEqual(["off-by-one"]);
    expect(r.failed).toBeUndefined();
    expect(r.labels.slice(0, 5)).toEqual([
      "review:correctness", "review:quality", "review:tests", "review:security", "review:architecture",
    ]);
  });

  it("runs the architecture dimension on kit-arbiter and the rest on kit-worker", async () => {
    const seen: Record<string, string | undefined> = {};
    await runReview({}, (prompt, opts) => {
      if (isReview(prompt)) seen[opts.label!] = opts.agentType;
      return isReview(prompt) ? { findings: [] } : { real: true };
    });
    expect(seen).toEqual({
      "review:correctness": "kit:kit-worker",
      "review:quality": "kit:kit-worker",
      "review:tests": "kit:kit-worker",
      "review:security": "kit:kit-worker",
      "review:architecture": "kit:kit-arbiter",
    });
  });

  it("reports partial naming a reviewer that returned null, keeping the other verified findings", async () => {
    const r = await runReview({ diffRef: "HEAD" }, (prompt, opts) =>
      opts.label === "review:security" ? null : oneRealFinding(prompt, opts),
    );
    expect(r.status).toBe("partial");
    expect(r.failed).toEqual([{ id: "review:security", error: expect.stringMatching(/did not complete/i) }]);
    expect(r.failed?.[0].error).toContain("report this to the user and wait for direction");
    expect(r.findings.map((f) => f.issue)).toEqual(["off-by-one"]);
  });

  it("reports a finding whose verifier returned null as unverified, not as a false positive", async () => {
    const r = await runReview({}, (prompt, opts) => (isVerdict(prompt) ? null : oneRealFinding(prompt, opts)));
    expect(r.status).toBe("partial");
    expect(r.findings).toEqual([]);
    expect(r.unverified?.map((f) => f.issue)).toEqual(["off-by-one"]);
    expect(r.failed?.map((f) => f.id)).toEqual(["verify:correctness:1"]);
  });

  it("drops a finding its verifier judged not real", async () => {
    const r = await runReview({}, (prompt, opts) => (isVerdict(prompt) ? { real: false } : oneRealFinding(prompt, opts)));
    expect(r.status).toBe("done");
    expect(r.findings).toEqual([]);
    expect(r.unverified ?? []).toEqual([]);
  });
});
