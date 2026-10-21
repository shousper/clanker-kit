import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { claude } from "../utils/harness/claude";
import { omp } from "../utils/harness/omp";
import { ROOT } from "../utils/paths";
import {
  analyseStandards,
  delegationViolations,
  readGateStates,
  STANDARDS_LANGS,
  standardsViolations,
  topLevelSessionId,
} from "../utils/standards-trace";

const CLAUDE_FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/claude-skill-activation.jsonl"), "utf-8");
const OMP_FAILED_READ = readFileSync(resolve(ROOT, "tests/fixtures/events/omp-failed-read.jsonl"), "utf-8");

const STD = "/p/kit-omp/code-standards/go/CLAUDE.md";

type Step = { tool: string; input: Record<string, unknown>; isError?: boolean; text?: string };

/** An OMP --mode json stream: one assistant call and its toolResult per step. */
function ompStream(steps: Step[]): string {
  return steps
    .flatMap((s, n) => [
      { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name: s.tool, arguments: s.input }] } },
      { type: "message_end", message: { role: "toolResult", toolCallId: `t${n}`, toolName: s.tool, isError: s.isError === true, content: [{ type: "text", text: s.text ?? "ok" }] } },
    ])
    .map((e) => JSON.stringify(e))
    .join("\n");
}

function claudeStream(steps: Step[]): string {
  return steps
    .flatMap((s, n) => [
      { type: "assistant", message: { content: [{ type: "tool_use", id: `t${n}`, name: s.tool, input: s.input }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, is_error: s.isError === true, content: s.text ?? "ok" }] } },
    ])
    .map((e) => JSON.stringify(e))
    .join("\n");
}

const BLOCK = `kit: before editing /w/main.go, read the Go standards in full at ${STD} and follow them for all Go code in this session, then retry this edit. kit asks once per language per session.`;
const EDIT = { tool: "write", input: { path: "/w/main.go", content: "package main" } };

const verdict = (stdout: string, lang: Parameters<typeof standardsViolations>[1] = "go") =>
  standardsViolations(analyseStandards(omp, omp.parse(stdout), lang), lang);

describe("standards trace", () => {
  it("passes the compliant sequence: blocked once, read, retried", () => {
    const out = ompStream([{ ...EDIT, isError: true, text: BLOCK }, { tool: "read", input: { path: STD } }, EDIT]);
    expect(verdict(out)).toEqual([]);
  });

  it("passes a proactive read with no block", () => {
    expect(verdict(ompStream([{ tool: "read", input: { path: STD } }, EDIT]))).toEqual([]);
  });

  it("passes the recorded HCL run, ignoring the failed skill:// attempt at the same path", () => {
    expect(verdict(OMP_FAILED_READ, "hcl")).toEqual([]);
  });

  it("fails an edit that landed with no read", () => {
    expect(verdict(ompStream([EDIT]))).toEqual([expect.stringContaining("exactly 1 successful read")]);
  });

  it("fails a read that came after the first successful edit", () => {
    const v = verdict(ompStream([EDIT, { tool: "read", input: { path: STD } }]));
    expect(v).toEqual([expect.stringContaining("read after the first successful go edit")]);
  });

  it("does not count a failed read, a ranged read, or another language's CLAUDE.md", () => {
    const out = ompStream([
      { tool: "read", input: { path: STD }, isError: true, text: "File not found" },
      { tool: "read", input: { path: `${STD}:1-50` } },
      { tool: "read", input: { path: "/p/kit-omp/code-standards/rust/CLAUDE.md" } },
      { tool: "read", input: { path: "/w/CLAUDE.md" } },
      EDIT,
    ]);
    expect(verdict(out)).toEqual([expect.stringContaining("saw 0")]);
  });

  it("fails a second block, and a block that names the wrong standards", () => {
    const wrong = BLOCK.replace("code-standards/go", "code-standards/rust");
    const twice = ompStream([{ ...EDIT, isError: true, text: BLOCK }, { ...EDIT, isError: true, text: BLOCK }, { tool: "read", input: { path: STD } }, EDIT]);
    expect(verdict(twice)).toEqual([expect.stringContaining("at most 1 gate block, saw 2")]);
    const mislabeled = ompStream([{ ...EDIT, isError: true, text: wrong }, { tool: "read", input: { path: STD } }, EDIT]);
    expect(verdict(mislabeled)).toEqual([expect.stringContaining("did not name code-standards/go/CLAUDE.md")]);
  });

  it("does not take a successful tool output that quotes the marker for a block", () => {
    const a = analyseStandards(omp, omp.parse(ompStream([{ tool: "bash", input: { command: "cat standards-gate.sh" }, text: BLOCK }])), "go");
    expect(a.blocks).toEqual([]);
  });

  it("requires an edit through an edit tool, so a shell edit cannot pass", () => {
    const out = ompStream([{ tool: "read", input: { path: STD } }, { tool: "bash", input: { command: "sed -i s/a/b/ main.go" } }]);
    expect(verdict(out)).toEqual([expect.stringContaining("no successful go edit")]);
  });

  it("reads the edited file from an OMP edit header and judges only the language's files", () => {
    const header = { tool: "edit", input: { input: "[/w/cmd/main.go#1A2B]\nPUT 1.=1:\n+package main" } };
    expect(verdict(ompStream([header]))).toEqual([expect.stringContaining("exactly 1 successful read")]);
    // An edit of a file outside the language is not a gated edit.
    expect(verdict(ompStream([{ tool: "read", input: { path: STD } }, { tool: "write", input: { path: "/w/notes.md" } }]))).toEqual([
      expect.stringContaining("no successful go edit"),
    ]);
  });

  it("handles claude: Read/Edit tool names, file_path, and an offset or limit voiding the read", () => {
    const stdout = (read: Record<string, unknown>) =>
      claudeStream([
        { tool: "Edit", input: { file_path: "/w/main.go" }, isError: true, text: BLOCK },
        { tool: "Read", input: { file_path: STD, ...read } },
        { tool: "Edit", input: { file_path: "/w/main.go" } },
      ]);
    expect(standardsViolations(analyseStandards(claude, claude.parse(stdout({})), "go"), "go")).toEqual([]);
    expect(standardsViolations(analyseStandards(claude, claude.parse(stdout({ limit: 40 })), "go"), "go")).toEqual([
      expect.stringContaining("saw 0"),
    ]);
  });
});

describe("delegation judged from the gate's state", () => {
  it("reads the top-level session id from each harness's stream", () => {
    expect(topLevelSessionId(claude, CLAUDE_FIXTURE)).toBe("2a100188-a172-43d5-9136-90747788e20e");
    expect(topLevelSessionId(omp, OMP_FAILED_READ)).toBe("01a0fb7e-0000-7000-8000-000000000001");
  });

  it("reads per-agent language states in order and ignores other scratch files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-states-"));
    try {
      writeFileSync(join(dir, "standards-agent-1.txt"), "go prompted\ngo loaded\nrust prompted\n");
      writeFileSync(join(dir, "touched-agent-1.txt"), "/w/main.go\n");
      expect(await readGateStates(dir)).toEqual({ "agent-1": { go: ["prompted", "loaded"], rust: ["prompted"] } });
      expect(await readGateStates(join(dir, "missing"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when a subagent, not the top-level agent, ended at loaded", () => {
    expect(delegationViolations({ sub: { go: ["prompted", "loaded"] } }, "top", "go")).toEqual([]);
    expect(delegationViolations({ sub: { go: ["loaded"] } }, "top", "go")).toEqual([]);
  });

  it("fails when the subagent was blocked and never read", () => {
    expect(delegationViolations({ sub: { go: ["prompted"] } }, "top", "go")).toEqual([expect.stringContaining('ends at "go loaded"')]);
    expect(delegationViolations({}, "top", "go")).toEqual([expect.stringContaining("agents seen: none")]);
  });

  it("fails when the top-level agent touched the language, since the subagent path was then not the one exercised", () => {
    const v = delegationViolations({ top: { go: ["prompted", "loaded"] }, sub: { go: ["loaded"] } }, "top", "go");
    expect(v).toEqual([expect.stringContaining("top-level agent touched go itself")]);
  });

  it("fails a subagent blocked twice", () => {
    const v = delegationViolations({ sub: { go: ["prompted", "prompted", "loaded"] } }, "top", "go");
    expect(v).toEqual([expect.stringContaining("blocked 2 times")]);
  });
});

describe("STANDARDS_LANGS", () => {
  /** The trace counts an edit as Python or C++ exactly when the gate can map its file to that language. */
  it("matches the files the gate maps to Python and C++", () => {
    const python = ["src/app.py", "stubs/app.pyi", "pyproject.toml"];
    const cpp = [
      "src/engine.cpp", "src/engine.cc", "src/engine.cxx", "include/engine.hpp", "include/engine.hh",
      "include/engine.hxx", "include/engine.ipp", "include/engine.tpp", "include/engine.inl",
      "include/engine.h", "CMakeLists.txt", "cmake/warnings.cmake", "CMakePresets.json",
    ];
    const neither = ["requirements.txt", "src/main.c", "notes.md", "setup.cfg"];
    for (const file of python) {
      expect(STANDARDS_LANGS.python.file.test(file), `${file} must count as a Python edit`).toBe(true);
    }
    for (const file of cpp) {
      expect(STANDARDS_LANGS.cpp.file.test(file), `${file} must count as a C++ edit`).toBe(true);
    }
    for (const file of neither) {
      expect(STANDARDS_LANGS.python.file.test(file), `${file} must not count as a Python edit`).toBe(false);
      expect(STANDARDS_LANGS.cpp.file.test(file), `${file} must not count as a C++ edit`).toBe(false);
    }
  });
});
