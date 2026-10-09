import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { claude } from "../utils/harness/claude";
import { scanStandardsFile } from "../../plugins/reports-omp/extensions/skills/report";
import { runNeutralScript } from "../utils/hook-workspace";
import { omp } from "../utils/harness/omp";
import { ROOT } from "../utils/paths";
import {
  analyseStandards,
  delegationViolations,
  gateStateViolations,
  readGateStates,
  STANDARDS_LANGS,
  standardsViolations,
  topLevelSessionId,
  type StandardsLang,
  unitFile,
  unitsFor,
  type StandardsUnit,
} from "../utils/standards-trace";

const CLAUDE_FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/claude-skill-activation.jsonl"), "utf-8");
const OMP_FAILED_READ = readFileSync(resolve(ROOT, "tests/fixtures/events/omp-failed-read.jsonl"), "utf-8");

const ROOT_P = "/p/kit-omp";
const STD = `${ROOT_P}/code-standards/go/core.md`;
const SCOPE = `${ROOT_P}/code-standards/scope.md`;
const PY_STD = `${ROOT_P}/code-standards/python/core.md`;
const PY_PROJECT = `${ROOT_P}/code-standards/python/project.md`;

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

const BLOCK = `kit: before editing /w/main.go, read these standards in full and follow them for all Go code in this session, then retry this edit: ${SCOPE}, ${STD}. kit asks once per standards file per session.`;
const EDIT = { tool: "write", input: { path: "/w/main.go", content: "package main" } };
const rd = (path: string): Step => ({ tool: "read", input: { path } });
const GO_UNITS = unitsFor("go");

const WHERE = { pluginRoot: ROOT_P, cwd: "/w" };

const verdict = (stdout: string, lang: Parameters<typeof standardsViolations>[1] = "go", units: StandardsUnit[] = unitsFor(lang), where = WHERE) =>
  standardsViolations(analyseStandards(omp, omp.parse(stdout), lang, units, where), lang, units);

describe("standards trace", () => {
  it("passes the compliant sequence: blocked once, both units read, retried", () => {
    const out = ompStream([{ ...EDIT, isError: true, text: BLOCK }, rd(SCOPE), rd(STD), EDIT]);
    expect(verdict(out)).toEqual([]);
  });

  it("passes a proactive read of every unit with no block", () => {
    expect(verdict(ompStream([rd(SCOPE), rd(STD), EDIT]))).toEqual([]);
  });

  it("passes when a failed read of a unit precedes its successful read", () => {
    const out = ompStream([
      { tool: "read", input: { path: "skill://code-standards/../../code-standards/go/core.md" }, isError: true, text: "File not found" },
      rd(SCOPE),
      rd(STD),
      EDIT,
    ]);
    expect(verdict(out)).toEqual([]);
  });

  it("fails an edit that landed with no read", () => {
    const v = verdict(ompStream([EDIT]));
    expect(v).toEqual([expect.stringContaining("scope"), expect.stringContaining("go")]);
    expect(v.every((x) => x.includes("exactly 1 successful read"))).toBe(true);
  });

  it("fails when scope.md is not read", () => {
    expect(verdict(ompStream([rd(STD), EDIT]))).toEqual([expect.stringContaining("code-standards/scope.md")]);
  });

  it("fails when a unit is read twice", () => {
    const v = verdict(ompStream([rd(SCOPE), rd(STD), rd(STD), EDIT]));
    expect(v).toEqual([expect.stringMatching(/code-standards\/go\/core\.md.*saw 2/)]);
  });

  it("fails a read that came after the first successful edit", () => {
    const v = verdict(ompStream([rd(SCOPE), EDIT, rd(STD)]));
    expect(v).toEqual([expect.stringContaining("go was read after the first successful go edit")]);
  });

  it("holds a source-edit case to a project facet the gate named when the agent edited a project file first", () => {
    const pyBlock = `kit: before editing /w/pyproject.toml, read these standards in full and follow them for all Python code in this session, then retry this edit: ${SCOPE}, ${PY_STD}, ${PY_PROJECT}. kit asks once per standards file per session.`;
    const pyEdit = { tool: "edit", input: { path: "pyproject.toml", input: "[pyproject.toml#AB12]" } };
    const units = unitsFor("python");
    expect(verdict(ompStream([{ ...pyEdit, isError: true, text: pyBlock }, rd(SCOPE), rd(PY_STD), rd(PY_PROJECT), pyEdit]), "python", units)).toEqual([]);
    expect(verdict(ompStream([{ ...pyEdit, isError: true, text: pyBlock }, rd(SCOPE), rd(PY_STD), pyEdit]), "python", units)).toEqual([
      expect.stringContaining("code-standards/python/project.md"),
    ]);
  });

  it("does not count a failed read, a ranged read, or a project CLAUDE.md", () => {
    const out = ompStream([
      rd(SCOPE),
      { tool: "read", input: { path: STD }, isError: true, text: "File not found" },
      { tool: "read", input: { path: `${STD}:1-50` } },
      { tool: "read", input: { path: STD, offset: 10 } },
      { tool: "read", input: { path: STD, limit: 10 } },
      rd("/w/CLAUDE.md"),
      EDIT,
    ]);
    expect(verdict(out)).toEqual([expect.stringMatching(/code-standards\/go\/core\.md.*saw 0/)]);
  });

  it("fails a second block, and a block that does not name an expected unit", () => {
    const twice = ompStream([{ ...EDIT, isError: true, text: BLOCK }, { ...EDIT, isError: true, text: BLOCK }, rd(SCOPE), rd(STD), EDIT]);
    expect(verdict(twice)).toEqual([expect.stringContaining("at most 1 gate block, saw 2")]);
    const noScope = BLOCK.replace(SCOPE, `${ROOT_P}/code-standards/rust/core.md`);
    const mislabeled = ompStream([{ ...EDIT, isError: true, text: noScope }, rd(SCOPE), rd(STD), EDIT]);
    expect(verdict(mislabeled)).toEqual([
      expect.stringContaining("code-standards/rust/core.md, saw 0"),
      expect.stringContaining("did not name code-standards/scope.md"),
    ]);
  });

  it("does not take a successful tool output that quotes the marker for a block", () => {
    const a = analyseStandards(omp, omp.parse(ompStream([{ tool: "bash", input: { command: "cat standards-gate.sh" }, text: BLOCK }])), "go", GO_UNITS, WHERE);
    expect(a.blocks).toEqual([]);
  });

  it("requires an edit through an edit tool, so a shell edit cannot pass", () => {
    const out = ompStream([rd(SCOPE), rd(STD), { tool: "bash", input: { command: "sed -i s/a/b/ main.go" } }]);
    expect(verdict(out)).toEqual([expect.stringContaining("no successful go edit")]);
  });

  it("reads the edited file from an OMP edit header and judges only the language's files", () => {
    const header = { tool: "edit", input: { input: "[/w/cmd/main.go#1A2B]\nPUT 1.=1:\n+package main" } };
    expect(verdict(ompStream([header]))).toEqual([expect.stringContaining("exactly 1 successful read"), expect.stringContaining("exactly 1 successful read")]);
    // An edit of a file outside the language is not a gated edit.
    expect(verdict(ompStream([rd(SCOPE), rd(STD), { tool: "write", input: { path: "/w/notes.md" } }]))).toEqual([
      expect.stringContaining("no successful go edit"),
    ]);
  });

  it("requires all three reads for a python project case", () => {
    const units = unitsFor("python", "project");
    const pyEdit = { tool: "write", input: { path: "/w/pyproject.toml", content: "" } };
    expect(verdict(ompStream([rd(SCOPE), rd(PY_STD), rd(PY_PROJECT), pyEdit]), "python", units)).toEqual([]);
    expect(verdict(ompStream([rd(SCOPE), rd(PY_STD), pyEdit]), "python", units)).toEqual([
      expect.stringMatching(/code-standards\/python\/project\.md.*saw 0/),
    ]);
    const block = `kit: before editing /w/pyproject.toml, read these standards in full and follow them for all Python code in this session, then retry this edit: ${SCOPE}, ${PY_STD}. kit asks once per standards file per session.`;
    const out = ompStream([{ ...pyEdit, isError: true, text: block }, rd(SCOPE), rd(PY_STD), rd(PY_PROJECT), pyEdit]);
    expect(verdict(out, "python", units)).toEqual([expect.stringContaining("did not name code-standards/python/project.md")]);
  });

  it("handles claude: Read/Edit tool names, file_path, and an offset or limit voiding the read", () => {
    const stdout = (read: Record<string, unknown>) =>
      claudeStream([
        { tool: "Edit", input: { file_path: "/w/main.go" }, isError: true, text: BLOCK },
        { tool: "Read", input: { file_path: SCOPE } },
        { tool: "Read", input: { file_path: STD, ...read } },
        { tool: "Edit", input: { file_path: "/w/main.go" } },
      ]);
    const judge = (s: string) => standardsViolations(analyseStandards(claude, claude.parse(s), "go", GO_UNITS, WHERE), "go", GO_UNITS);
    expect(judge(stdout({}))).toEqual([]);
    expect(judge(stdout({ limit: 40 }))).toEqual([expect.stringMatching(/go\/core\.md.*saw 0/)]);
  });
});

describe("standards reads are matched to the exact paths the gate names", () => {
  const OTHER_ROOT_STD = "/home/u/.claude/plugins/cache/kit/1.0.0/code-standards/go/core.md";
  const DID_NOT_NAME = (path: string) => `read a standards file that the gate did not name: ${path}`;

  it("passes an exact path, a :raw suffix, and a relative path resolved against the trial's cwd", () => {
    expect(verdict(ompStream([rd(SCOPE), rd(`${STD}:raw`), EDIT]))).toEqual([]);
    const relative = { pluginRoot: ROOT_P, cwd: "/p" };
    expect(verdict(ompStream([rd("kit-omp/code-standards/scope.md"), rd("./kit-omp/code-standards/go/core.md"), EDIT]), "go", GO_UNITS, relative)).toEqual([]);
  });

  it("does not count a same-suffix read from another root for the unit, and flags it", () => {
    expect(verdict(ompStream([rd(SCOPE), rd(OTHER_ROOT_STD), EDIT]))).toEqual([
      expect.stringMatching(/code-standards\/go\/core\.md.*saw 0/),
      DID_NOT_NAME(OTHER_ROOT_STD),
    ]);
  });

  it("flags a relative read that resolves into another root", () => {
    const elsewhere = { pluginRoot: ROOT_P, cwd: "/home/u/other" };
    const v = verdict(ompStream([rd(SCOPE), rd("kit-omp/code-standards/go/core.md"), EDIT]), "go", GO_UNITS, elsewhere);
    expect(v).toEqual([expect.stringMatching(/go\/core\.md.*saw 0/), DID_NOT_NAME("kit-omp/code-standards/go/core.md")]);
  });

  it("flags a read of another language's standards file, even from the right root", () => {
    const rust = `${ROOT_P}/code-standards/rust/core.md`;
    expect(verdict(ompStream([rd(SCOPE), rd(STD), rd(rust), EDIT]))).toEqual([DID_NOT_NAME(rust)]);
  });

  it("does not flag a ranged read of an expected file, which only fails to count", () => {
    const out = ompStream([rd(SCOPE), { tool: "read", input: { path: `${STD}:1-50` } }, { tool: "read", input: { path: STD, limit: 5 } }, rd(STD), EDIT]);
    expect(verdict(out)).toEqual([]);
  });

  it("counts a read through a symlink to the plugin root, and not a separate copy of the same files", () => {
    const dir = mkdtempSync(join(tmpdir(), "standards-roots-"));
    try {
      const real = join(dir, "real");
      const copy = join(dir, "copy");
      for (const root of [real, copy]) {
        for (const unit of GO_UNITS) {
          mkdirSync(dirname(join(root, unitFile(unit))), { recursive: true });
          writeFileSync(join(root, unitFile(unit)), "# stub\n");
        }
      }
      symlinkSync(real, join(dir, "alias"));
      const where = { pluginRoot: real, cwd: dir };
      const reads = (root: string) => ompStream([...GO_UNITS.map((u) => rd(join(root, unitFile(u)))), EDIT]);
      expect(verdict(reads(join(dir, "alias")), "go", GO_UNITS, where)).toEqual([]);
      expect(verdict(reads(copy), "go", GO_UNITS, where)).toEqual([
        expect.stringMatching(/scope\.md.*saw 0/),
        expect.stringMatching(/go\/core\.md.*saw 0/),
        DID_NOT_NAME(join(copy, unitFile("scope"))),
        DID_NOT_NAME(join(copy, unitFile("go"))),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the same matching to claude's file_path reads", () => {
    const judge = (s: string) => standardsViolations(analyseStandards(claude, claude.parse(s), "go", GO_UNITS, WHERE), "go", GO_UNITS);
    const edit = { tool: "Edit", input: { file_path: "/w/main.go" } };
    expect(judge(claudeStream([{ tool: "Read", input: { file_path: SCOPE } }, { tool: "Read", input: { file_path: STD } }, edit]))).toEqual([]);
    expect(judge(claudeStream([{ tool: "Read", input: { file_path: SCOPE } }, { tool: "Read", input: { file_path: OTHER_ROOT_STD } }, edit]))).toEqual([
      expect.stringMatching(/go\/core\.md.*saw 0/),
      DID_NOT_NAME(OTHER_ROOT_STD),
    ]);
  });
});

describe("searching for standards files", () => {
  const SEARCHED = "searched for standards files instead of reading the paths in the block";
  const claudeJudge = (s: string) => standardsViolations(analyseStandards(claude, claude.parse(s), "go", GO_UNITS, WHERE), "go", GO_UNITS);
  const claudeReads: Step[] = [
    { tool: "Read", input: { file_path: SCOPE } },
    { tool: "Read", input: { file_path: STD } },
  ];
  const claudeEdit: Step = { tool: "Edit", input: { file_path: "/w/main.go" } };

  const OMP_SEARCHES: [string, Record<string, unknown>][] = [
    ["glob", { path: "/p/kit-omp/code-standards/**/*.md" }],
    ["grep", { pattern: "Go standards", path: "/p/kit-omp/code-standards" }],
    ["find", { query: "where are the code-standards files", grep_keywords: ["code-standards"] }],
    ["bash", { command: "ls /p/kit-omp/code-standards/go" }],
    ["search", { query: "code-standards go core" }],
  ];
  const CLAUDE_SEARCHES: [string, Record<string, unknown>][] = [
    ["Glob", { pattern: "**/code-standards/go/*.md" }],
    ["Grep", { pattern: "error handling", path: "/p/kit-omp/code-standards" }],
    ["Bash", { command: "find / -path '*code-standards*' -name core.md" }],
    ["LS", { path: "/p/kit-omp/code-standards" }],
  ];

  for (const [tool, input] of OMP_SEARCHES) {
    it(`flags omp ${tool} mentioning code-standards before the edit, and not after it`, () => {
      const before = verdict(ompStream([{ tool, input }, rd(SCOPE), rd(STD), EDIT]));
      expect(before).toEqual([expect.stringContaining(`${SEARCHED}: ${tool}(`)]);
      expect(verdict(ompStream([rd(SCOPE), rd(STD), EDIT, { tool, input }]))).toEqual([]);
    });
  }

  for (const [tool, input] of CLAUDE_SEARCHES) {
    it(`flags claude ${tool} mentioning code-standards before the edit, and not after it`, () => {
      const before = claudeJudge(claudeStream([{ tool, input }, ...claudeReads, claudeEdit]));
      expect(before).toEqual([expect.stringContaining(`${SEARCHED}: ${tool}(`)]);
      expect(claudeJudge(claudeStream([...claudeReads, claudeEdit, { tool, input }]))).toEqual([]);
    });
  }

  it("flags a search even when it failed, since the call itself is the violation", () => {
    const out = ompStream([{ tool: "glob", input: { path: "**/code-standards/**" }, isError: true, text: "boom" }, rd(SCOPE), rd(STD), EDIT]);
    expect(verdict(out)).toEqual([expect.stringContaining(SEARCHED)]);
  });

  it("does not flag a search or listing that never mentions the standards files", () => {
    const out = ompStream([{ tool: "grep", input: { pattern: "func main", path: "/w" } }, { tool: "bash", input: { command: "ls /w" } }, rd(SCOPE), rd(STD), EDIT]);
    expect(verdict(out)).toEqual([]);
  });

  it("flags a read of a code-standards directory before the edit", () => {
    for (const dir of [`${ROOT_P}/code-standards`, `${ROOT_P}/code-standards/`, `${ROOT_P}/code-standards/go`]) {
      expect(verdict(ompStream([rd(dir), rd(SCOPE), rd(STD), EDIT]))).toEqual([expect.stringContaining(SEARCHED)]);
    }
    expect(claudeJudge(claudeStream([{ tool: "Read", input: { file_path: `${ROOT_P}/code-standards/go` } }, ...claudeReads, claudeEdit]))).toEqual([
      expect.stringContaining(SEARCHED),
    ]);
  });
});

describe("gate state of the top-level agent", () => {
  const units = unitsFor("go");

  it("passes when every expected unit ended at loaded, with or without a block first", () => {
    expect(gateStateViolations({ top: { scope: ["loaded"], go: ["prompted", "loaded"] } }, "top", units)).toEqual([]);
  });

  it("flags a unit that ends at prompted, naming the unit", () => {
    const v = gateStateViolations({ top: { scope: ["loaded"], go: ["prompted"] } }, "top", units);
    expect(v).toEqual([expect.stringContaining("go")]);
  });

  it("flags a unit with no recorded state, and states that belong to another agent", () => {
    expect(gateStateViolations({ top: { scope: ["loaded"] } }, "top", units)).toEqual([expect.stringContaining("go")]);
    expect(gateStateViolations({ sub: { scope: ["loaded"], go: ["loaded"] } }, "top", units)).toHaveLength(2);
  });

  it("flags a missing top-level session id", () => {
    expect(gateStateViolations({ top: { scope: ["loaded"], go: ["loaded"] } }, undefined, units)).toEqual([expect.stringContaining("session id")]);
  });
});

describe("standards units", () => {
  it("maps each unit to its file under code-standards", () => {
    expect(unitFile("scope")).toBe("code-standards/scope.md");
    expect(unitFile("go")).toBe("code-standards/go/core.md");
    expect(unitFile("cpp:project")).toBe("code-standards/cpp/project.md");
  });

  it("lists scope and the core unit, plus the project unit when the case has that facet", () => {
    expect(unitsFor("rust")).toEqual(["scope", "rust"]);
    expect(unitsFor("rust", "project")).toEqual(["scope", "rust", "rust:project"]);
  });
});

describe("delegation judged from the gate's state", () => {
  it("reads the top-level session id from each harness's stream", () => {
    expect(topLevelSessionId(claude, CLAUDE_FIXTURE)).toBe("2a100188-a172-43d5-9136-90747788e20e");
    expect(topLevelSessionId(omp, OMP_FAILED_READ)).toBe("01a0fb7e-0000-7000-8000-000000000001");
  });

  it("reads per-agent unit states in order, ignores cpp-root lines and other scratch files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-states-"));
    try {
      writeFileSync(
        join(dir, "standards-agent-1.txt"),
        "scope prompted\ngo prompted\nscope loaded\ngo loaded\npython:project prompted\ncpp-root yes /w/native\n",
      );
      writeFileSync(join(dir, "touched-agent-1.txt"), "/w/main.go\n");
      expect(await readGateStates(dir)).toEqual({
        "agent-1": { scope: ["prompted", "loaded"], go: ["prompted", "loaded"], "python:project": ["prompted"] },
      });
      expect(await readGateStates(join(dir, "missing"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const LOADED = { scope: ["prompted", "loaded"], go: ["prompted", "loaded"] };

  it("passes when a subagent, not the top-level agent, ended every unit at loaded", () => {
    expect(delegationViolations({ sub: LOADED }, "top", "go")).toEqual([]);
    expect(delegationViolations({ sub: { scope: ["loaded"], go: ["loaded"] } }, "top", "go")).toEqual([]);
  });

  it("passes when the expected units include the project unit and the subagent loaded all three", () => {
    const units = unitsFor("python", "project");
    const sub = { scope: ["loaded"], python: ["loaded"], "python:project": ["prompted", "loaded"] };
    expect(delegationViolations({ sub }, "top", "python", units)).toEqual([]);
    expect(delegationViolations({ sub: { scope: ["loaded"], python: ["loaded"] } }, "top", "python", units)).toEqual([
      expect.stringContaining("python:project"),
    ]);
  });

  it("fails when the subagent was blocked and never read", () => {
    expect(delegationViolations({ sub: { scope: ["prompted"], go: ["prompted"] } }, "top", "go")).toEqual([
      expect.stringContaining("sub"),
    ]);
    expect(delegationViolations({}, "top", "go")).toEqual([expect.stringContaining("agents seen: none")]);
  });

  it("fails when the subagent loaded the language but left scope prompted", () => {
    const v = delegationViolations({ sub: { scope: ["prompted"], go: ["prompted", "loaded"] } }, "top", "go");
    expect(v).toEqual([expect.stringContaining("scope")]);
  });

  it("fails when the subagent never touched scope at all", () => {
    const v = delegationViolations({ sub: { go: ["loaded"] } }, "top", "go");
    expect(v).toEqual([expect.stringContaining("scope")]);
  });

  it("fails when the top-level agent touched any expected unit, since the subagent path was then not the one exercised", () => {
    expect(delegationViolations({ top: { go: ["prompted", "loaded"] }, sub: LOADED }, "top", "go")).toEqual([
      expect.stringContaining("top-level agent"),
    ]);
    expect(delegationViolations({ top: { scope: ["prompted"] }, sub: LOADED }, "top", "go")).toEqual([
      expect.stringContaining("top-level agent"),
    ]);
  });

  it("fails a subagent blocked twice on a unit", () => {
    const v = delegationViolations({ sub: { scope: ["loaded"], go: ["prompted", "prompted", "loaded"] } }, "top", "go");
    expect(v).toEqual([expect.stringContaining("blocked 2 times")]);
  });
});

describe("STANDARDS_LANGS", () => {
  it("counts the Rust and C++ project files as edits in their language", () => {
    for (const file of ["clippy.toml", "rust-toolchain.toml", "crates/a/clippy.toml"]) {
      expect(STANDARDS_LANGS.rust.file.test(file), `${file} must count as a Rust edit`).toBe(true);
    }
    for (const file of [".clang-tidy", ".clang-format", "src/.clang-format"]) {
      expect(STANDARDS_LANGS.cpp.file.test(file), `${file} must count as a C++ edit`).toBe(true);
    }
    expect(STANDARDS_LANGS.rust.file.test("notclippy.toml")).toBe(false);
  });

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

/** A file the gate blocks on, with the language and project facet it must map to. */
type MappedFile = [file: string, lang: StandardsLang, facet?: "project"];

const MAPPED_FILES: MappedFile[] = [
  ["main.go", "go"],
  ["go.mod", "go"],
  ["lib.rs", "rust"],
  ["Cargo.toml", "rust", "project"],
  ["clippy.toml", "rust", "project"],
  ["rust-toolchain.toml", "rust", "project"],
  ["main.tf", "hcl"],
  ["App.tsx", "tailwindcss"],
  ["app.py", "python"],
  ["pyproject.toml", "python", "project"],
  ["main.cpp", "cpp"],
  ["app.h", "cpp"],
  ["CMakeLists.txt", "cpp", "project"],
  ["toolchain.cmake", "cpp", "project"],
  ["CMakePresets.json", "cpp", "project"],
  [".clang-tidy", "cpp", "project"],
  [".clang-format", "cpp", "project"],
];

describe("gate, trace helper and report agree on the unit mapping", () => {
  /** One fixture: a fake plugin root with every unit file, and a repository with C++, Tailwind and Python signals. */
  it("map each file to the same units and language", async () => {
    const base = mkdtempSync(join(tmpdir(), "standards-parity-"));
    try {
      const pluginRoot = join(base, "plugin");
      const units: StandardsUnit[] = ["scope"];
      for (const lang of Object.keys(STANDARDS_LANGS) as StandardsLang[]) units.push(lang, `${lang}:project`);
      for (const unit of units) {
        mkdirSync(dirname(join(pluginRoot, unitFile(unit))), { recursive: true });
        writeFileSync(join(pluginRoot, unitFile(unit)), "# standards\n");
      }
      const repo = join(base, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      for (const signal of ["main.cpp", "tailwind.config.js", "pyproject.toml"]) writeFileSync(join(repo, signal), "");

      let counter = 0;
      for (const [file, lang, facet] of MAPPED_FILES) {
        const path = join(repo, file);
        const gate = await runNeutralScript("standards-gate.sh", {
          args: ["check", path],
          cwd: repo,
          env: {
            KIT_PLUGIN_ROOT: pluginRoot,
            KIT_STATE_DIR: join(base, "state"),
            KIT_SCRATCH_KEY: `parity-${++counter}`,
            GIT_CEILING_DIRECTORIES: base,
          },
        });
        expect(gate.exitCode, `${file} must be blocked`).toBe(2);
        const listed = /then retry this edit: (.+?)\. kit asks once per standards file/.exec(gate.stdout)?.[1] ?? "";
        const gateUnits = listed.split(", ").map((p) => units.find((u) => p === join(pluginRoot, unitFile(u))) ?? p);

        expect(gateUnits, `${file}: units the gate names`).toEqual(unitsFor(lang, facet));

        const blocked = scanStandardsFile(
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "edit", arguments: { path } }] },
          }) +
            "\n" +
            JSON.stringify({
              type: "message",
              timestamp: "2026-01-01T00:00:01.000Z",
              message: { role: "toolResult", toolCallId: "b1", isError: true, content: [{ type: "text", text: gate.stdout }] },
            }),
        );
        expect(
          blocked.map((e) => [e.kind, e.unit, e.root]),
          `${file}: block events the report reads from the gate's reason`,
        ).toEqual(unitsFor(lang, facet).map((unit) => ["block", unit, pluginRoot]));

        const edited = scanStandardsFile(
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path } }] },
          }) +
            "\n" +
            JSON.stringify({
              type: "message",
              timestamp: "2026-01-01T00:00:01.000Z",
              message: { role: "toolResult", toolCallId: "e1", isError: false, content: [{ type: "text", text: "ok" }], details: { path } },
            }),
        )
          .filter((e) => e.kind === "edit")
          .map((e) => e.unit);
        const reportLang = edited.find((u) => u !== "scope" && !u.endsWith(":project"));
        expect(reportLang, `${file}: language the report assigns`).toBe(lang);
        expect(edited.sort(), `${file}: units the report counts`).toEqual([...unitsFor(lang, facet)].sort());
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
