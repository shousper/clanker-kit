import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { CODE_STANDARDS_DIR } from "../utils/paths";

describe("bundled code standards", () => {
  it("every language directory ships a standards file with real content", () => {
    // The standards gate treats an existing code-standards/<lang>/CLAUDE.md as a
    // reason to block an edit and send the agent to read it. A heading-only
    // placeholder sends agents to a file that teaches them nothing.
    const languages = readdirSync(CODE_STANDARDS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(languages.length).toBeGreaterThan(0);
    for (const lang of languages) {
      const text = readFileSync(resolve(CODE_STANDARDS_DIR, lang.name, "CLAUDE.md"), "utf-8");
      expect(text.length, `code-standards/${lang.name}/CLAUDE.md`).toBeGreaterThan(1500);
    }
  });
});

describe("HCL code standard", () => {
  it("covers the required sections", () => {
    const text = readFileSync(resolve(CODE_STANDARDS_DIR, "hcl/CLAUDE.md"), "utf-8");
    for (const heading of ["File", "Naming", "Variables", "Outputs", "Resources", "Version", "Tooling"]) {
      expect(text).toContain(heading);
    }
  });

  it("does NOT leak lynx-devops bespoke patterns", () => {
    const text = readFileSync(resolve(CODE_STANDARDS_DIR, "hcl/CLAUDE.md"), "utf-8").toLowerCase();
    expect(text).not.toContain("ident");        // bespoke ident map
    expect(text).not.toContain("configure module"); // bespoke multi-provider pattern
  });
});

const readStandard = (lang: string): string => readFileSync(resolve(CODE_STANDARDS_DIR, lang, "CLAUDE.md"), "utf-8");

const codeBlocks = (text: string, language: string): string[] =>
  [...text.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```", "gm"))].map((match) => match[1]);

const LINE_LIMITS: Record<string, number> = { python: 750, cpp: 900 };

const SHARED_SCOPE_RULES = [
  "- Project settings never override the Never rules in this section or the Security rules.",
  "- Never raise the language version of the project.",
  "- Never change the build system or replace a tool of the project unless the task asks for it.",
  "- Never create a tool configuration file in an existing project unless the task asks for it.",
  "- Never reformat or fix a file that the task does not change.",
  "- Never update a lock file unless the task changes a dependency.",
  "- Never relax a compiler, lint, type-check or sanitizer setting to pass a check. Fix the code.",
  "- Never log, print or commit a secret.",
];

describe("Python and C++ code standards", () => {
  /** Both files carry the same scope rules, so agents get 1 contract across languages. */
  it("carry the shared scope rules word for word", () => {
    for (const lang of Object.keys(LINE_LIMITS)) {
      const text = readStandard(lang);
      for (const rule of SHARED_SCOPE_RULES) {
        expect(text.includes(rule), `${lang}/CLAUDE.md must contain the rule: ${rule}`).toBe(true);
      }
    }
  });

  /** The gate makes an agent read the whole file, so each file stays within its line budget. */
  it("stay within their line limits", () => {
    for (const [lang, limit] of Object.entries(LINE_LIMITS)) {
      const lineCount = readStandard(lang).trimEnd().split("\n").length;
      expect(lineCount, `${lang}/CLAUDE.md has ${lineCount} lines, over its limit of ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  /** Examples use the Good and Bad comments of the Go and Rust files, and the gate alone decides activation. */
  it("mark examples with Good and Bad comments and have no activation section", () => {
    for (const lang of Object.keys(LINE_LIMITS)) {
      const text = readStandard(lang);
      expect(/[✅❌]/u.test(text), `${lang}/CLAUDE.md must mark examples with Good and Bad comments, not emoji`).toBe(false);
      expect(text.includes("## When This Activates"), `${lang}/CLAUDE.md must not have an activation section`).toBe(false);
    }
  });

  /** Each file opens with its scope, then its dependencies. */
  it("open with Scope and Precedence, then Dependencies", () => {
    for (const lang of Object.keys(LINE_LIMITS)) {
      const headings = readStandard(lang).split("\n").filter((line) => line.startsWith("## "));
      expect(headings.slice(0, 2), `${lang}/CLAUDE.md must open with Scope and Precedence, then Dependencies`).toEqual([
        "## Scope and Precedence",
        "## Dependencies",
      ]);
    }
  });
});

describe("Python code standard", () => {
  /** The required sections exist, so the file covers the same ground as its siblings. */
  it("covers the required sections", () => {
    const text = readStandard("python");
    for (const heading of ["## Environment and Commands", "## Type Hints", "## Error Handling", "## Logging", "## Security", "## Testing"]) {
      expect(text.includes(heading), `python/CLAUDE.md must have the section ${heading}`).toBe(true);
    }
  });

  /** Tools run through the environment manager, and the project keeps its own type checker. */
  it("runs tools through uv and keeps the type checker of the project", () => {
    const text = readStandard("python");
    expect(text.includes("uv sync --locked"), "python/CLAUDE.md must sync with uv sync --locked").toBe(true);
    expect(text.includes("Never add a 2nd type checker."), "python/CLAUDE.md must forbid a 2nd type checker").toBe(true);
    const shellExamples = codeBlocks(text, "bash").join("\n");
    expect(/^\s*(python|ruff|mypy|pytest)\b/m.test(shellExamples), "python/CLAUDE.md shell examples must run tools through uv run").toBe(false);
  });
});

describe("C++ code standard", () => {
  /** The required sections exist, so the file covers the same ground as its siblings. */
  it("covers the required sections", () => {
    const text = readStandard("cpp");
    for (const heading of ["## Build and Tooling", "## Resource Management", "## Error Handling and Contracts", "## Concurrency", "## Security", "## Testing"]) {
      expect(text.includes(heading), `cpp/CLAUDE.md must have the section ${heading}`).toBe(true);
    }
  });

  /** The baseline is C++20, so no example needs a C++23 library feature. */
  it("sets C++20 as the baseline and keeps C++23 library features out of the examples", () => {
    const text = readStandard("cpp");
    expect(text.includes("CMAKE_CXX_STANDARD 20"), "cpp/CLAUDE.md must set C++20 as the baseline").toBe(true);
    const examples = codeBlocks(text, "cpp").join("\n");
    for (const feature of ["std::expected", "std::unexpected", "std::print", "std::byteswap", "std::flat_map", "std::mdspan", "std::move_only_function", "std::to_underlying", "std::unreachable", "function_ref"]) {
      expect(examples.includes(feature), `a C++ example uses ${feature}, which C++20 does not provide`).toBe(false);
    }
  });
});
