import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { CODE_STANDARDS_DIR } from "../utils/paths";

const size = (path: string): number => statSync(path).size;

const languageDirs = (): string[] =>
  readdirSync(CODE_STANDARDS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

/** Markdown files under a directory, as paths relative to the standards root. */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [relative(CODE_STANDARDS_DIR, path)] : [];
  });
}

describe("bundled code standards", () => {
  /** The gate sends an agent to read core.md in full, so a stub teaches nothing and a long file is not read well. */
  it("every language directory ships a core.md within the byte budget", () => {
    const languages = languageDirs();
    expect(languages.length).toBeGreaterThan(0);
    for (const lang of languages) {
      const core = resolve(CODE_STANDARDS_DIR, lang, "core.md");
      expect(existsSync(core), `code-standards/${lang}/core.md must exist`).toBe(true);
      expect(size(core), `code-standards/${lang}/core.md`).toBeGreaterThanOrEqual(1024);
      expect(size(core), `code-standards/${lang}/core.md`).toBeLessThanOrEqual(10240);
    }
  });

  it("ships a scope.md within the byte budget", () => {
    const scope = resolve(CODE_STANDARDS_DIR, "scope.md");
    expect(existsSync(scope), "code-standards/scope.md must exist").toBe(true);
    expect(size(scope)).toBeLessThanOrEqual(3072);
  });

  it("keeps every project.md within the byte budget", () => {
    for (const lang of languageDirs()) {
      const project = resolve(CODE_STANDARDS_DIR, lang, "project.md");
      if (!existsSync(project)) continue;
      expect(size(project), `code-standards/${lang}/project.md`).toBeLessThanOrEqual(8192);
    }
  });

  /** The gate asks for scope.md, core.md and project.md only, so any other Markdown file never reaches an agent. */
  it("names every Markdown file scope.md, core.md or project.md", () => {
    const files = markdownFiles(CODE_STANDARDS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parts = file.split("/");
      const valid =
        (parts.length === 1 && parts[0] === "scope.md") ||
        (parts.length === 2 && (parts[1] === "core.md" || parts[1] === "project.md"));
      expect(valid, `code-standards/${file} is not a unit file the gate asks for`).toBe(true);
    }
  });
});
