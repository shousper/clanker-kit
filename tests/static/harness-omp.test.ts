import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { omp } from "../utils/harness/omp";
import type { ToolResultEvent } from "../utils/harness/types";
import { ROOT } from "../utils/paths";

const FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/omp-skill-activation.jsonl"), "utf-8");
const FALLBACK_ERROR_FIXTURE = readFileSync(
  resolve(ROOT, "tests/fixtures/events/omp-fallback-error.jsonl"),
  "utf-8",
);
const FAILED_READ_FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/omp-failed-read.jsonl"), "utf-8");

describe("omp adapter", () => {
  it("pins an exact, provider-qualified model id, never a fuzzy alias", () => {
    const args = omp.buildArgs("hi", {});
    const model = args[args.indexOf("--model") + 1];
    expect(model).toBe("anthropic/claude-sonnet-5");
    expect(model).not.toBe("sonnet"); // fuzzy-matches a dead model and silently falls back
    expect(model).not.toBe("claude-sonnet-5"); // bare id is ambiguous across providers
  });

  it("bounds runs with --max-time because omp has no --max-turns", () => {
    const args = omp.buildArgs("hi", { maxTurns: 3, timeout: 60_000 });
    expect(args).toContain("--max-time");
    expect(args).not.toContain("--max-turns");
  });

  it("claims more wall-clock than claude, and self-terminates at the scaled budget", () => {
    // Measured ~2.2x slower. Unscaled, parity trials died at exit 124 mid-run and the
    // timeout was misreported as an activation failure.
    expect(omp.timeoutScale).toBeGreaterThan(2);
    const args = omp.buildArgs("hi", { timeout: 60_000 });
    // --max-time is seconds and must reflect the SCALED budget, not the raw one.
    expect(Number(args[args.indexOf("--max-time") + 1])).toBe(150);
  });

  it("loads plugins with -e so extension modules run, not --plugin-dir", () => {
    // --plugin-dir loads skills and agents but NOT package.json#omp.extensions, so the
    // hook bridge would never inject the using-kit governance block. Evaluating that way
    // measures a configuration we don't ship.
    const args = omp.buildArgs("hi", { pluginDirs: ["/p/kit"] });
    expect(args).not.toContain("--plugin-dir");
    expect(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2)).toEqual(["-e", "/p/kit"]);
  });

  it("dedupes the tool call repeated across message_end and turn_end", () => {
    const calls = omp.parse(FIXTURE).filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "read", input: { path: "skill://tdd" } });
  });

  it("detects activation via a skill:// read", () => {
    const events = omp.parse(FIXTURE);
    expect(omp.skillActivationSignal(events, "tdd")).toBe(true);
    expect(omp.skillActivationSignal(events, "kit:tdd")).toBe(true);
    expect(omp.skillActivationSignal(events, "brainstorming")).toBe(false);
  });

  it("surfaces a silent model fallback as a structured event", () => {
    const events = omp.parse(FALLBACK_ERROR_FIXTURE);
    expect(events).toContainEqual({
      kind: "fallback",
      from: "claude-sonnet-4-5",
      to: "claude-sonnet-4-0",
    });
  });

  it("surfaces an extension runner failure as a structured error event", () => {
    const events = omp.parse(FALLBACK_ERROR_FIXTURE);
    expect(events).toContainEqual({
      kind: "error",
      message: "extension crashed: ENOENT config.json",
    });
  });

  it("emits each tool outcome once, keyed by the call it answers, with its error flag", () => {
    const results = omp.parse(FAILED_READ_FIXTURE).filter((e): e is ToolResultEvent => e.kind === "tool_result");
    expect(results.map((r) => [r.id, r.isError])).toEqual([
      ["toolu_failRead01", true],
      ["toolu_blocked002", true],
      ["toolu_stdRead003", false],
      ["toolu_write00004", false],
    ]);
    expect(results[0].text).toStartWith("File not found:");
    expect(results[1].text).toStartWith("kit: before editing");
  });

  it("emits only assistant prose as text, not the prompt or tool output", () => {
    const texts = omp.parse(FIXTURE).filter((e) => e.kind === "text").map((e) => (e.kind === "text" ? e.text : ""));
    expect([...new Set(texts)]).toEqual(["DONE"]);
  });

  it("does not count a failed skill:// read as an activation", () => {
    // The real defect: skill://code-standards/../../code-standards/hcl/CLAUDE.md fails to
    // resolve, yet the call alone used to score as activation.
    const events = omp.parse(FAILED_READ_FIXTURE);
    expect(events).toContainEqual({
      kind: "tool_call",
      tool: "read",
      input: { path: "skill://code-standards/../../code-standards/hcl/CLAUDE.md" },
      id: "toolu_failRead01",
    });
    expect(omp.skillActivationSignal(events, "code-standards")).toBe(false);
  });
});
