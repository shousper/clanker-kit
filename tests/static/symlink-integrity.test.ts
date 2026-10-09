import { describe, it, expect } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { HOOKS_DIR, KIT_CLAUDE_ROOT, KIT_OMP_ROOT, ROOT, SKILLS_DIR } from "../utils/paths";

// A dangling symlink is a SILENT failure: the plugin loader follows symlinks and just
// won't find the file, with no error pointing back at shared/. These guards make that
// failure mode loud at test time instead.

const PLUGINS_ROOT = resolve(ROOT, "plugins");

/** Every symlink reachable under `dir`. Symlinked directories are leaves here — we only
 *  need each link's own target checked, not what's inside it (that subtree is walked
 *  independently wherever it really lives). */
function collectSymlinks(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(full);
      continue;
    }
    if (entry.isDirectory()) collectSymlinks(full, found);
  }
  return found;
}

/** Every path reachable from `dir`, FOLLOWING symlinked directories, with cycle
 *  protection via realpath dedup. Used to pin the harness dividing line: it must hold
 *  even through a chain of symlinks into shared/, not just in the plugin's own real files. */
function walkFollowing(dir: string, visited = new Set<string>(), out: string[] = []): string[] {
  const real = realpathSync(dir);
  if (visited.has(real)) return out;
  visited.add(real);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out.push(full);
    if (existsSync(full) && statSync(full).isDirectory()) walkFollowing(full, visited, out);
  }
  return out;
}

/** Every REGULAR FILE reachable from `dir`, following symlinked directories. Used for
 *  content-based dividing-line checks (a banned token in any file's text), as opposed
 *  to `walkFollowing`'s path-based checks. */
function walkFilesFollowing(dir: string): string[] {
  return walkFollowing(dir).filter((p) => existsSync(p) && statSync(p).isFile());
}

// Token-boundary match: catches "omp", "omp.md", "harness-omp-profile.md", but not
// "component.md" (an unrelated word that happens to contain the substring "omp").
const OMP_TOKEN = /(^|[^a-z])omp([^a-z]|$)/i;

describe("symlink integrity", () => {
  it("every shared skill is linked into BOTH plugins/kit-claude/skills and plugins/kit-omp/skills", () => {
    const sharedSkills = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(sharedSkills.length).toBeGreaterThan(0);
    for (const name of sharedSkills) {
      expect(existsSync(resolve(KIT_CLAUDE_ROOT, "skills", name)), `plugins/kit-claude/skills/${name} missing`).toBe(true);
      expect(existsSync(resolve(KIT_OMP_ROOT, "skills", name)), `plugins/kit-omp/skills/${name} missing`).toBe(true);
    }
  });

  it("no symlink under plugins/ dangles", () => {
    const symlinks = collectSymlinks(PLUGINS_ROOT);
    expect(symlinks.length).toBeGreaterThan(0);
    for (const link of symlinks) {
      expect(existsSync(link), `${relative(ROOT, link)} -> dangling (target does not exist)`).toBe(true);
    }
  });

  it.each([
    ["build-flow", "build.workflow.js"],
    ["code-review", "review.workflow.js"],
  ])("plugins/kit-claude/skills/%s has a real launch.md and %s", (skill, workflowFile) => {
    expect(existsSync(resolve(KIT_CLAUDE_ROOT, "skills", skill, "launch.md"))).toBe(true);
    expect(existsSync(resolve(KIT_CLAUDE_ROOT, "skills", skill, workflowFile))).toBe(true);
  });

  it.each([
    ["build-flow", "build.workflow.mjs"],
    ["code-review", "review.workflow.mjs"],
  ])("plugins/kit-omp/skills/%s has a real launch.md and %s", (skill, workflowFile) => {
    expect(existsSync(resolve(KIT_OMP_ROOT, "skills", skill, "launch.md"))).toBe(true);
    expect(existsSync(resolve(KIT_OMP_ROOT, "skills", skill, workflowFile))).toBe(true);
  });

  describe("harness dividing line: hooks", () => {
    const KIT_CLAUDE_HOOKS_DIR = resolve(KIT_CLAUDE_ROOT, "hooks");

    it("plugins/kit-claude/hooks is a real directory (not a whole-dir symlink)", () => {
      expect(lstatSync(KIT_CLAUDE_HOOKS_DIR).isSymbolicLink()).toBe(false);
      expect(lstatSync(KIT_CLAUDE_HOOKS_DIR).isDirectory()).toBe(true);
    });

    it("plugins/kit-claude/hooks contains hooks.json and every protocol wrapper as real, executable files", () => {
      const wrappers = [
        "session-start.sh", "record.sh", "format-on-stop.sh", "hcl-detect.sh",
        "standards-check.sh", "standards-seen.sh", "standards-reset.sh", "state-cleanup.sh",
      ];
      for (const name of ["hooks.json", ...wrappers]) {
        const full = resolve(KIT_CLAUDE_HOOKS_DIR, name);
        expect(existsSync(full), `${name} missing`).toBe(true);
        expect(lstatSync(full).isSymbolicLink(), `${name} should be a real file`).toBe(false);
        if (wrappers.includes(name)) {
          expect(statSync(full).mode & 0o111, `${name} should be executable`).not.toBe(0);
        }
      }
    });

    it("plugins/kit-claude/hooks/shared resolves to shared/hooks", () => {
      const link = resolve(KIT_CLAUDE_HOOKS_DIR, "shared");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(HOOKS_DIR));
    });

    it("plugins/kit-omp/hooks remains a whole-dir symlink to shared/hooks", () => {
      const link = resolve(KIT_OMP_ROOT, "hooks");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(HOOKS_DIR));
    });

    it("shared/hooks contains no .json (no Claude-schema hooks.json)", () => {
      const jsonFiles = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".json"));
      expect(jsonFiles).toEqual([]);
    });

    it("shared/hooks/*.sh carries no harness protocol string", () => {
      const BANNED = /hookSpecificOutput|systemMessage|permissionDecision|stop_hook_active|tool_input|CLAUDE_/;
      const scripts = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".sh"));
      expect(scripts.length).toBeGreaterThan(0);
      const offending = scripts.filter((f) => BANNED.test(readFileSync(resolve(HOOKS_DIR, f), "utf-8")));
      expect(offending).toEqual([]);
    });
  });

  describe("harness dividing line: kit-claude", () => {
    it("contains no path matching omp, following symlinks", () => {
      const offending = walkFollowing(KIT_CLAUDE_ROOT)
        .map((p) => relative(KIT_CLAUDE_ROOT, p))
        .filter((p) => OMP_TOKEN.test(p));
      expect(offending).toEqual([]);
    });

    it("contains no .mjs workflow file", () => {
      const offending = walkFollowing(KIT_CLAUDE_ROOT).filter((p) => p.endsWith(".mjs"));
      expect(offending).toEqual([]);
    });

    it("contains no skill:// reference in any file", () => {
      const offending = walkFilesFollowing(KIT_CLAUDE_ROOT).filter((p) => readFileSync(p, "utf-8").includes("skill://"));
      expect(offending).toEqual([]);
    });
  });

  describe("harness dividing line: kit-omp", () => {
    it("contains no launch-claude resource, following symlinks", () => {
      const offending = walkFollowing(KIT_OMP_ROOT)
        .map((p) => relative(KIT_OMP_ROOT, p))
        .filter((p) => p.includes("launch-claude"));
      expect(offending).toEqual([]);
    });

    it("contains no .claude-plugin manifest dir", () => {
      const offending = walkFollowing(KIT_OMP_ROOT)
        .map((p) => relative(KIT_OMP_ROOT, p))
        .filter((p) => p.includes(".claude-plugin"));
      expect(offending).toEqual([]);
    });

    it("contains no Workflow( call in any file", () => {
      const offending = walkFilesFollowing(KIT_OMP_ROOT).filter((p) => readFileSync(p, "utf-8").includes("Workflow("));
      expect(offending).toEqual([]);
    });

    it("contains no TaskOutput reference in any file", () => {
      const offending = walkFilesFollowing(KIT_OMP_ROOT).filter((p) => readFileSync(p, "utf-8").includes("TaskOutput"));
      expect(offending).toEqual([]);
    });
  });
});
