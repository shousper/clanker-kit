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
