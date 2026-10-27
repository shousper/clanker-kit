import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { scanStandardsFile, standardsOutcomes } from "../../plugins/reports-omp/extensions/skills/report";

const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function call(n: number, id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    timestamp: stamp(n),
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  });
}

function result(n: number, id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    timestamp: stamp(n),
    message: { role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text: "ok" }], ...extra },
  });
}

const transcript = (...lines: string[]) => lines.join("\n");

const readOf = (path: string) => transcript(call(1, "r1", "read", { path }), result(2, "r1"));

describe("scanStandardsFile", () => {
  it("reads the project facet as its own unit", () => {
    const events = scanStandardsFile(readOf("/root/code-standards/python/project.md"));
    expect(events.map((e) => [e.kind, e.unit, e.root])).toEqual([["read", "python:project", "/root"]]);
  });

  it("reads scope.md as the scope unit", () => {
    const events = scanStandardsFile(readOf("/root/code-standards/scope.md"));
    expect(events.map((e) => [e.kind, e.unit])).toEqual([["read", "scope"]]);
  });

  it("reads a language core file as the language unit, including a :raw read", () => {
    const events = scanStandardsFile(readOf("/root/code-standards/cpp/core.md:raw"));
    expect(events.map((e) => [e.kind, e.unit])).toEqual([["read", "cpp"]]);
  });

  it("ignores a ranged read", () => {
    expect(scanStandardsFile(readOf("/root/code-standards/scope.md:1-20"))).toEqual([]);
  });

  it("emits one block event per unit named in the block reason", () => {
    const reason =
      "kit: before editing /w/src/app.py, read these standards in full and follow them for all Python code in this session, " +
      "then retry this edit: /kit/code-standards/scope.md, /kit/code-standards/python/core.md, /kit/code-standards/python/project.md. " +
      "kit asks once per standards file per session.";
    const text = transcript(
      call(1, "e1", "edit", { path: "/w/src/app.py" }),
      result(2, "e1", { isError: true, content: [{ type: "text", text: reason }] }),
    );
    const events = scanStandardsFile(text);
    expect(events.map((e) => [e.kind, e.unit, e.root])).toEqual([
      ["block", "scope", "/kit"],
      ["block", "python", "/kit"],
      ["block", "python:project", "/kit"],
    ]);
  });

  it("reads the unit list when a tool hint follows the block reason", () => {
    const reason =
      "kit: before editing /w/main.tf, read these standards in full and follow them for all HCL code in this session, " +
      "then retry this edit: /kit/code-standards/scope.md, /kit/code-standards/hcl/core.md. " +
      "kit asks once per standards file per session. Run tofu fmt after editing.";
    const text = transcript(
      call(1, "e1", "edit", { path: "/w/main.tf" }),
      result(2, "e1", { isError: true, content: [{ type: "text", text: reason }] }),
    );
    expect(scanStandardsFile(text).map((e) => e.unit)).toEqual(["scope", "hcl"]);
  });

  it("reads a pre-upgrade code-standards/<lang>/CLAUDE.md file as the language core unit, including :raw", () => {
    const events = scanStandardsFile(readOf("/root/code-standards/go/CLAUDE.md"));
    expect(events.map((e) => [e.kind, e.unit, e.root])).toEqual([["read", "go", "/root"]]);
    expect(scanStandardsFile(readOf("/root/code-standards/go/CLAUDE.md:raw")).map((e) => e.unit)).toEqual(["go"]);
    expect(scanStandardsFile(readOf("/root/code-standards/go/CLAUDE.md:1-20"))).toEqual([]);
  });

  it("reads the pre-upgrade block reason as a block of the language core unit", () => {
    const reason =
      "kit: before editing /w/main.go, read the Go standards in full at /kit/code-standards/go/CLAUDE.md and follow them for all Go code in this session, " +
      "then retry this edit. kit asks once per language per session.";
    const text = transcript(
      call(1, "e1", "edit", { path: "/w/main.go" }),
      result(2, "e1", { isError: true, content: [{ type: "text", text: reason }] }),
    );
    expect(scanStandardsFile(text).map((e) => [e.kind, e.unit, e.root])).toEqual([["block", "go", "/kit"]]);
  });

  it("pairs a pre-upgrade block, full read and retried edit as blocked and read before the edit", () => {
    const reason =
      "kit: before editing /w/main.go, read the Go standards in full at /kit/code-standards/go/CLAUDE.md and follow them for all Go code in this session, " +
      "then retry this edit. kit asks once per language per session.";
    const text = transcript(
      call(1, "e1", "edit", { path: "/w/main.go" }),
      result(2, "e1", { isError: true, content: [{ type: "text", text: reason }] }),
      call(3, "r1", "read", { path: "/kit/code-standards/go/CLAUDE.md" }),
      result(4, "r1"),
      call(5, "e2", "edit", { path: "/w/main.go" }),
      result(6, "e2", { details: { path: "/w/main.go" } }),
    );
    const go = standardsOutcomes(scanStandardsFile(text), 0, Number.POSITIVE_INFINITY).find((o) => o.unit === "go")!;
    expect(go.edited).toBe(true);
    expect(go.readBefore).toBe(true);
    expect(go.blocked).toBe(true);
    expect(go.readAfterBlock).toBe(true);
    expect(go.root).toBe("/kit");
  });

  it("parses the block and the read in the recorded pre-upgrade OMP fixture", () => {
    const fixture = readFileSync(resolve(import.meta.dir, "../fixtures/events/omp-failed-read.jsonl"), "utf-8");
    const events = scanStandardsFile(fixture);
    expect(events.filter((e) => e.kind !== "edit").map((e) => [e.kind, e.unit, e.root])).toEqual([
      ["block", "hcl", "/home/u/kit/plugins/kit-omp"],
      ["read", "hcl", "/home/u/kit/plugins/kit-omp"],
    ]);
  });

  it("counts an edit against the language core unit and scope", () => {
    const edit = (file: string) =>
      scanStandardsFile(
        transcript(call(1, "e1", "edit", { path: file }), result(2, "e1", { details: { path: file } })),
      )
        .filter((e) => e.kind === "edit")
        .map((e) => e.unit)
        .sort();
    expect(edit("/w/src/app.py")).toEqual(["python", "scope"]);
    expect(edit("/w/src/main.cpp")).toEqual(["cpp", "scope"]);
  });

  it("counts a project file edit against scope, the language and its project unit", () => {
    const edit = (file: string) =>
      scanStandardsFile(
        transcript(call(1, "e1", "edit", { path: file }), result(2, "e1", { details: { path: file } })),
      )
        .filter((e) => e.kind === "edit")
        .map((e) => e.unit)
        .sort();
    expect(edit("/w/pyproject.toml")).toEqual(["python", "python:project", "scope"]);
    expect(edit("/w/crates/a/clippy.toml")).toEqual(["rust", "rust:project", "scope"]);
    expect(edit("/w/rust-toolchain.toml")).toEqual(["rust", "rust:project", "scope"]);
  });

  it("counts shared C and C++ files only inside a C++ repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "reports-cpp-"));
    try {
      const c = join(dir, "c");
      const cpp = join(dir, "cpp");
      for (const d of [c, cpp]) mkdirSync(join(d, ".git"), { recursive: true });
      writeFileSync(join(c, "main.c"), "");
      writeFileSync(join(cpp, "main.cpp"), "");
      const edit = (file: string) =>
        scanStandardsFile(
          transcript(call(1, "e1", "edit", { path: file }), result(2, "e1", { details: { path: file } })),
        )
          .filter((e) => e.kind === "edit")
          .map((e) => e.unit)
          .sort();
      expect(edit(join(c, "util.h"))).toEqual([]);
      expect(edit(join(c, "CMakeLists.txt"))).toEqual([]);
      expect(edit(join(cpp, "util.h"))).toEqual(["cpp", "scope"]);
      expect(edit(join(cpp, ".clang-tidy"))).toEqual(["cpp", "cpp:project", "scope"]);
      expect(edit(join(cpp, "CMakeLists.txt"))).toEqual(["cpp", "cpp:project", "scope"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The report counts a file as a unit's edit exactly when the gate maps it there (C++ root aside, set up on disk). */
  it("maps files to the same units as the gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "reports-gate-"));
    try {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "main.cpp"), "");
      const files = [
        "a.go", "go.mod", "go.sum", "a.rs", "Cargo.toml", "clippy.toml", "rust-toolchain.toml", "a.tf", "a.tofu",
        "a.tofu.json", "a.tfvars", "a.py", "a.pyi", "pyproject.toml", "a.cpp", "a.cc", "a.cxx", "a.hpp", "a.hh",
        "a.hxx", "a.ipp", "a.tpp", "a.inl", "a.h", "CMakeLists.txt", "a.cmake", "CMakePresets.json", ".clang-tidy",
        ".clang-format", "a.c", "notes.md", "setup.cfg",
      ];
      const gate = resolve(import.meta.dir, "../../shared/hooks/standards-gate.sh");
      const probe = `source ${JSON.stringify(gate)} >/dev/null 2>&1; for f in ${files.map((f) => JSON.stringify(join(dir, f))).join(" ")}; do GATE_UNITS=; gate_units_for "$f" || true; echo "$GATE_UNITS"; done`;
      const out = Bun.spawnSync(["bash", "-c", probe], { env: { ...process.env, KIT_SCRATCH_KEY: "reports-pin", KIT_STATE_DIR: dir } });
      const expected = out.stdout.toString().split("\n").slice(0, files.length).map((l) => l.trim().split(/\s+/).filter(Boolean).sort());
      files.forEach((file, i) => {
        const path = join(dir, file);
        const got = scanStandardsFile(
          transcript(call(1, "e1", "edit", { path }), result(2, "e1", { details: { path } })),
        )
          .map((e) => e.unit)
          .sort();
        expect(got, file).toEqual(expected[i]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("standardsOutcomes", () => {
  it("reports readBefore per unit", () => {
    const text = transcript(
      call(1, "r1", "read", { path: "/kit/code-standards/scope.md" }),
      result(2, "r1"),
      call(3, "r2", "read", { path: "/kit/code-standards/python/core.md" }),
      result(4, "r2"),
      call(5, "e1", "edit", { path: "/w/src/app.py" }),
      result(6, "e1", { details: { path: "/w/src/app.py" } }),
    );
    const outcomes = standardsOutcomes(scanStandardsFile(text), 0, Number.POSITIVE_INFINITY);
    const byUnit = Object.fromEntries(outcomes.map((o) => [o.unit, o]));
    expect(Object.keys(byUnit).sort()).toEqual(["python", "scope"]);
    expect(byUnit.scope.readBefore).toBe(true);
    expect(byUnit.python.readBefore).toBe(true);
    expect(byUnit.python.edited).toBe(true);
  });

  it("marks a unit read late when its read follows the first edit", () => {
    const text = transcript(
      call(1, "r1", "read", { path: "/kit/code-standards/scope.md" }),
      result(2, "r1"),
      call(3, "e1", "edit", { path: "/w/src/app.py" }),
      result(4, "e1", { details: { path: "/w/src/app.py" } }),
      call(5, "r2", "read", { path: "/kit/code-standards/python/core.md" }),
      result(6, "r2"),
    );
    const outcomes = standardsOutcomes(scanStandardsFile(text), 0, Number.POSITIVE_INFINITY);
    const byUnit = Object.fromEntries(outcomes.map((o) => [o.unit, o]));
    expect(byUnit.scope.readBefore).toBe(true);
    expect(byUnit.python.readBefore).toBe(false);
    expect(byUnit.python.readLate).toBe(true);
  });
});
