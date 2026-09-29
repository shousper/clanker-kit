import { describe, it, expect } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { extractFrontmatter } from "../utils/skill-parser";
import { MARKETPLACE_DIR, OMP_MARKETPLACE_DIR, ROOT, STORIES_CLAUDE_ROOT, STORIES_OMP_ROOT, STORIES_ROOT, STORIES_SKILLS_DIR } from "../utils/paths";

const SHARED_SKILLS = ["using-stories", "setup", "plan", "cancel"];

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
const walkFiles = (dir: string) => walkFollowing(dir).filter((p) => existsSync(p) && statSync(p).isFile());
const linksTo = (link: string, target: string) => lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(target);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

const OMP_TOKEN = /(^|[^a-z])omp([^a-z]|$)/i;
// The full harness-neutral vocabulary for shared/ is enforced by neutral-prose.test.ts,
// which walks every file under shared/ (including shared/stories). This list is the
// protocol-level subset the stories split adds on top: hook payload fields, the
// Claude env prefix, and the Claude workflow launch.
const HARNESS_PROTOCOL = /CLAUDE_|hookSpecificOutput|permissionDecision|systemMessage|TaskOutput|Workflow\(/;
const LEGACY_ALLOWED = new Set(["lib/util.mjs", "lib/doctor.mjs"]);
// The OMP plugin's own files may name Claude only in the pre-split marker the
// extension still recognises (design: adapters keep injecting the rules on a
// legacy layout).
const OMP_CLAUDE_ALLOWED = [".claude/story-workflow.json"];

describe("shared/stories", () => {
  it("carries no harness protocol string in lib, bin, or skills", () => {
    for (const sub of ["lib", "bin", "skills"]) {
      const offending = walkFiles(resolve(STORIES_ROOT, sub)).filter((p) => HARNESS_PROTOCOL.test(readFileSync(p, "utf-8")));
      expect(offending.map((p) => relative(ROOT, p))).toEqual([]);
    }
  });

  it("names the legacy .claude layout only in util.mjs and doctor.mjs", () => {
    const offending = walkFiles(STORIES_ROOT)
      .filter((p) => readFileSync(p, "utf-8").includes(".claude"))
      .map((p) => relative(STORIES_ROOT, p))
      .filter((p) => !LEGACY_ALLOWED.has(p) && p !== "README.md");
    expect(offending).toEqual([]);
  });
});

describe("plugins/stories-claude", () => {
  it("declares the plugin name stories with no OMP manifest, and its catalogue entry matches", () => {
    const manifest = readJson(resolve(STORIES_CLAUDE_ROOT, ".claude-plugin/plugin.json"));
    expect(manifest.name).toBe("stories");
    expect(existsSync(resolve(STORIES_CLAUDE_ROOT, ".omp-plugin"))).toBe(false);
    const entry = readJson(resolve(MARKETPLACE_DIR, "marketplace.json")).plugins.find((p: { name: string }) => p.name === "stories");
    expect(entry.source).toBe("./plugins/stories-claude");
    expect(entry.version).toBe(manifest.version);
  });

  it("links lib, GUIDE.md, the four shared skills, and the work skill's shared parts into shared/stories", () => {
    expect(linksTo(resolve(STORIES_CLAUDE_ROOT, "lib"), resolve(STORIES_ROOT, "lib"))).toBe(true);
    expect(linksTo(resolve(STORIES_CLAUDE_ROOT, "GUIDE.md"), resolve(STORIES_ROOT, "README.md"))).toBe(true);
    for (const s of SHARED_SKILLS) expect(linksTo(resolve(STORIES_CLAUDE_ROOT, "skills", s), resolve(STORIES_SKILLS_DIR, s)), s).toBe(true);
    expect(linksTo(resolve(STORIES_CLAUDE_ROOT, "skills/work/SKILL.md"), resolve(STORIES_SKILLS_DIR, "work/SKILL.md"))).toBe(true);
    expect(linksTo(resolve(STORIES_CLAUDE_ROOT, "skills/work/references"), resolve(STORIES_SKILLS_DIR, "work/references"))).toBe(true);
  });

  it("keeps its harness files real: the bin shim, hooks, launch.md, and the .js runner", () => {
    for (const f of ["README.md", "bin/story", "hooks/hooks.json", "hooks/common.sh", "hooks/session-start.sh", "hooks/stop-loop.sh", "hooks/guard.sh", "skills/work/launch.md", "skills/work/plan.workflow.js"]) {
      const full = resolve(STORIES_CLAUDE_ROOT, f);
      expect(existsSync(full), f).toBe(true);
      expect(lstatSync(full).isSymbolicLink(), f).toBe(false);
    }
    expect(readFileSync(resolve(STORIES_CLAUDE_ROOT, "bin/story"), "utf-8")).toContain("CLAUDE_SESSION_ID");
  });

  it("declares exactly SessionStart, Stop, and PreToolUse hooks whose commands exist", () => {
    const config = readJson(resolve(STORIES_CLAUDE_ROOT, "hooks/hooks.json"));
    expect(Object.keys(config.hooks).sort()).toEqual(["PreToolUse", "SessionStart", "Stop"]);
    for (const entries of Object.values(config.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(existsSync(hook.command.replace("${CLAUDE_PLUGIN_ROOT}", STORIES_CLAUDE_ROOT)), hook.command).toBe(true);
        }
      }
    }
  });

  it("contains no omp path token, no .mjs runner, and no mention of OMP in its own files", () => {
    const paths = walkFollowing(STORIES_CLAUDE_ROOT).map((p) => relative(STORIES_CLAUDE_ROOT, p));
    expect(paths.filter((p) => OMP_TOKEN.test(p))).toEqual([]);
    expect(paths.filter((p) => p.endsWith(".workflow.mjs"))).toEqual([]);
    const own = walkFiles(STORIES_CLAUDE_ROOT).filter((p) => !realpathSync(p).startsWith(realpathSync(STORIES_ROOT)));
    expect(own.filter((p) => OMP_TOKEN.test(readFileSync(p, "utf-8"))).map((p) => relative(ROOT, p))).toEqual([]);
  });
});

describe("plugins/stories-omp", () => {
  it("declares the plugin name stories with no Claude manifest, and its catalogue entry matches", () => {
    const manifest = readJson(resolve(STORIES_OMP_ROOT, ".omp-plugin/plugin.json"));
    expect(manifest.name).toBe("stories");
    expect(existsSync(resolve(STORIES_OMP_ROOT, ".claude-plugin"))).toBe(false);
    const entry = readJson(resolve(OMP_MARKETPLACE_DIR, "marketplace.json")).plugins.find((p: { name: string }) => p.name === "stories");
    expect(entry.source).toBe("./plugins/stories-omp");
    expect(entry.version).toBe(manifest.version);
  });

  it("registers its extension through package.json", () => {
    const pkg = readJson(resolve(STORIES_OMP_ROOT, "package.json"));
    expect(pkg.name).toBe("stories-omp");
    expect(pkg.private).toBe(true);
    expect(pkg.omp.extensions).toEqual(["./omp/index.ts"]);
    expect(existsSync(resolve(STORIES_OMP_ROOT, "omp/index.ts"))).toBe(true);
    expect(readFileSync(resolve(STORIES_OMP_ROOT, "omp/index.ts"), "utf-8")).toMatch(/registerHooks/);
  });

  it("links bin, lib, GUIDE.md, the four shared skills, and the work skill's shared parts into shared/stories", () => {
    expect(linksTo(resolve(STORIES_OMP_ROOT, "bin"), resolve(STORIES_ROOT, "bin"))).toBe(true);
    expect(linksTo(resolve(STORIES_OMP_ROOT, "lib"), resolve(STORIES_ROOT, "lib"))).toBe(true);
    expect(linksTo(resolve(STORIES_OMP_ROOT, "GUIDE.md"), resolve(STORIES_ROOT, "README.md"))).toBe(true);
    for (const s of SHARED_SKILLS) expect(linksTo(resolve(STORIES_OMP_ROOT, "skills", s), resolve(STORIES_SKILLS_DIR, s)), s).toBe(true);
    expect(linksTo(resolve(STORIES_OMP_ROOT, "skills/work/SKILL.md"), resolve(STORIES_SKILLS_DIR, "work/SKILL.md"))).toBe(true);
    expect(linksTo(resolve(STORIES_OMP_ROOT, "skills/work/references"), resolve(STORIES_SKILLS_DIR, "work/references"))).toBe(true);
  });

  it("keeps README.md, launch.md, and the .mjs runner real, and ships no .js runner", () => {
    for (const f of ["README.md", "skills/work/launch.md", "skills/work/plan.workflow.mjs"]) {
      const full = resolve(STORIES_OMP_ROOT, f);
      expect(existsSync(full), f).toBe(true);
      expect(lstatSync(full).isSymbolicLink(), f).toBe(false);
    }
    expect(walkFollowing(STORIES_OMP_ROOT).filter((p) => p.endsWith(".workflow.js"))).toEqual([]);
  });

  it("carries no Claude protocol in its own files, and no Workflow( or TaskOutput anywhere, following symlinks", () => {
    const own = walkFiles(STORIES_OMP_ROOT).filter((p) => !realpathSync(p).startsWith(realpathSync(STORIES_ROOT)));
    const offending = own.filter((p) => {
      const text = OMP_CLAUDE_ALLOWED.reduce((t, lit) => t.replaceAll(lit, ""), readFileSync(p, "utf-8"));
      return /claude/i.test(text);
    });
    expect(offending.map((p) => relative(ROOT, p))).toEqual([]);
    expect(walkFiles(STORIES_OMP_ROOT).filter((p) => /Workflow\(|TaskOutput/.test(readFileSync(p, "utf-8"))).map((p) => relative(ROOT, p))).toEqual([]);
  });

  it("ships the three planner agents on built-in roles, never the task tier, and no vendor model ids", () => {
    const chains: Record<string, string[]> = {
      routine: ["@plan", "@default"],
      hard: ["@slow", "@plan"],
      frontier: ["@slow"],
    };
    for (const [tier, chain] of Object.entries(chains)) {
      const raw = readFileSync(resolve(STORIES_OMP_ROOT, "agents", `story-planner-${tier}.md`), "utf-8");
      const { frontmatter, body } = extractFrontmatter(raw);
      expect(frontmatter.name).toBe(`story-planner-${tier}`);
      expect(typeof frontmatter.description).toBe("string");
      expect(frontmatter.model).toEqual(chain);
      expect(frontmatter.thinkingLevel).toBe(tier === "routine" ? "high" : "xhigh");
      expect(body.trim().length).toBeGreaterThan(0);
      expect(raw).not.toMatch(/anthropic\//);
      expect(raw.toLowerCase()).not.toContain("claude");
    }
  });
});
