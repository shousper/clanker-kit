import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, realpathSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { ROOT } from "../utils/paths";

// A skill's companion files must be reachable from the skill's own directory. An agent
// that follows a path in a skill resolves it from the skill directory, and OMP's
// skill:// loader clamps dot segments at the host (skill://code-standards/../x becomes
// <skill dir>/code-standards/x), so a path that leaves the skill directory fails with
// no hint of why. 27 failed reads came from `agents/code-reviewer.md` alone.
//
// The scan covers every plugin's skill directories as the harness sees them, following
// symlinks into shared/, so a shared SKILL.md is checked against each plugin's real
// per-harness files (launch.md, *.workflow.js or .mjs).

const PLUGINS_DIR = resolve(ROOT, "plugins");
const SCRIPT_EXT = /\.(md|mjs|js|sh|py)$/;

// Illustrative references: file names that appear in examples inside a skill and are
// not meant to exist. Keyed by "<skill>/<file relative to the skill dir>". Keep this
// list to examples; a reference that should resolve must be fixed, not listed.
const ILLUSTRATIVE: Record<string, string[]> = {
  // Anthropic's skill-authoring guide, vendored verbatim; its examples describe an
  // imaginary PDF-form skill.
  "writing-skills/anthropic-best-practices.md": [
    "analyze_form.py",
    "doc2.md",
    "form_validation_rules.md",
    "pdf_to_images.py",
    "validate_form.py",
  ],
};

interface RefContext {
  skillName: string;
  /** Does `rel` exist when resolved from the skill directory (or the referencing file's directory)? */
  inSkill(rel: string): boolean;
  /** Does `rel` exist when resolved from the plugin root? */
  inPluginRoot(rel: string): boolean;
  illustrative: readonly string[];
}

/** Drop fenced code blocks, honouring fence length so a four-backtick example that
 *  contains three-backtick blocks is removed whole. */
function stripFences(text: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && /^\s*[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Problems with the companion-file references in one markdown document. */
function companionProblems(markdown: string, ctx: RefContext): string[] {
  const text = stripFences(markdown);
  const problems: string[] = [];
  const bare = new Set<string>();

  for (const span of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = span[1].trim();
    if (!/^(\.\/)?[\w@.-]+(\/[\w@.-]+)*$/.test(raw)) continue; // placeholders, commands, globs, URLs
    if (!/\.\w{1,8}$/.test(raw)) continue; // not a file
    const ref = raw.replace(/^\.\//, "");
    const segments = ref.split("/");

    if (segments.includes("..") || segments[0] === "shared") {
      problems.push(`\`${raw}\` leaves the skill directory; reference only files inside it`);
    } else if (segments.length > 1 && segments[0] === ctx.skillName && !ctx.inSkill(ref)) {
      problems.push(`\`${raw}\` repeats the skill name; paths resolve from the skill directory, so drop "${ctx.skillName}/"`);
    } else if (!ctx.inSkill(ref) && ctx.inPluginRoot(ref)) {
      problems.push(`\`${raw}\` exists only relative to the plugin root; the skill directory does not contain it`);
    } else if (segments.length === 1 && SCRIPT_EXT.test(ref)) {
      bare.add(ref);
    }
  }
  // Bare .md mentions outside backticks: "@file.md", "see file.md", "**file.md**".
  for (const m of text.matchAll(/@([a-z][\w-]*\.md)\b/g)) bare.add(m[1]);
  for (const m of text.matchAll(/(?:see |See |\*\*)`?([a-z][\w-]*\.md)`?\*?\*?/g)) bare.add(m[1]);

  for (const ref of bare) {
    if (ref === "SKILL.md" || ref === "CLAUDE.md") continue; // the skill itself; a project's own file
    if (ctx.illustrative.includes(ref)) continue;
    if (!ctx.inSkill(ref)) problems.push(`\`${ref}\` does not exist in the skill directory`);
  }
  return problems;
}

function fakeContext(skillName: string, inSkill: string[], inPluginRoot: string[]): RefContext {
  return {
    skillName,
    inSkill: (rel) => inSkill.includes(rel),
    inPluginRoot: (rel) => inPluginRoot.includes(rel),
    illustrative: [],
  };
}

describe("companion-path checker", () => {
  it("rejects the code-standards table: paths that climb out of the skill directory", () => {
    const table = "| `*.go` | Go | `../../code-standards/go/CLAUDE.md` |\n";
    const problems = companionProblems(table, fakeContext("code-standards", [], []));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("../../code-standards/go/CLAUDE.md");
  });

  it("rejects a plugin-root path such as the code-review rubric", () => {
    const text = "- **Review rubric:** `agents/code-reviewer.md` is the canonical framework.\n";
    const problems = companionProblems(text, fakeContext("code-review", ["SKILL.md"], ["agents/code-reviewer.md"]));
    expect(problems).toEqual(["`agents/code-reviewer.md` exists only relative to the plugin root; the skill directory does not contain it"]);
  });

  it("rejects a path that repeats the skill name", () => {
    const text = "See `code-review/dispatch-template.md` for the placeholders.\n";
    const problems = companionProblems(text, fakeContext("code-review", ["dispatch-template.md"], []));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("drop \"code-review/\"");
  });

  it("rejects an authoring-tree path that does not exist in an installed plugin", () => {
    const text = "The agent definition (`shared/agents/code-reviewer.md`) supplies the framework.\n";
    expect(companionProblems(text, fakeContext("code-review", [], []))).toHaveLength(1);
  });

  it("rejects a bare script name the skill directory lacks, as `./name` or `name`", () => {
    const ctx = fakeContext("code-review", ["launch.md", "review.workflow.mjs"], []);
    expect(companionProblems("The runner is `./review.workflow.js`.\n", ctx)).toHaveLength(1);
    expect(companionProblems("Run `find-polluter.sh` in this directory.\n", ctx)).toHaveLength(1);
  });

  it("accepts files that sit in the skill directory, with or without ./", () => {
    const ctx = fakeContext("code-review", ["launch.md", "review.workflow.mjs", "references/rubric.md"], []);
    const text = "Read `launch.md`, then run `./review.workflow.mjs`; the rubric is `references/rubric.md`.\n";
    expect(companionProblems(text, ctx)).toEqual([]);
  });

  it("ignores placeholders, commands, URLs, globs, and fenced examples", () => {
    const text = [
      "Use `<base>/review.workflow.js` and `npm run build.js` and `https://x.dev/a.md` and `src/**/*.test.ts`.",
      "```bash",
      "./find-polluter.sh '.git'",
      "```",
      "````md",
      "```",
      "`missing.md`",
      "```",
      "````",
      "",
    ].join("\n");
    expect(companionProblems(text, fakeContext("debugging", [], []))).toEqual([]);
  });

  it("accepts a bare reference listed as illustrative", () => {
    const ctx = { ...fakeContext("writing-skills", [], []), illustrative: ["validate_form.py"] };
    expect(companionProblems("Run `validate_form.py` to check.\n", ctx)).toEqual([]);
  });
});

/** Every .md file under `dir`, following symlinked directories (cycle-safe). */
function markdownFiles(dir: string, seen = new Set<string>(), out: string[] = []): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) return out;
  seen.add(real);
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!existsSync(full)) continue; // dangling links are symlink-integrity's job
    if (statSync(full).isDirectory()) markdownFiles(full, seen, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

interface SkillDoc {
  plugin: string;
  skill: string;
  skillDir: string;
  file: string;
}

const docs: SkillDoc[] = readdirSync(PLUGINS_DIR)
  .filter((plugin) => existsSync(join(PLUGINS_DIR, plugin, "skills")))
  .flatMap((plugin) =>
    readdirSync(join(PLUGINS_DIR, plugin, "skills"))
      .filter((skill) => statSync(join(PLUGINS_DIR, plugin, "skills", skill)).isDirectory())
      .flatMap((skill) => {
        const skillDir = join(PLUGINS_DIR, plugin, "skills", skill);
        return markdownFiles(skillDir).map((file) => ({ plugin, skill, skillDir, file }));
      }),
  );

describe("skill companion paths in plugin skill directories", () => {
  it("scans the kit, stories, and writing skills for both harnesses", () => {
    const plugins = new Set(docs.map((d) => d.plugin));
    for (const p of ["kit-claude", "kit-omp", "stories-claude", "stories-omp", "writing-claude", "writing-omp"]) {
      expect(plugins.has(p), `no skill docs found under plugins/${p}`).toBe(true);
    }
  });

  for (const doc of docs) {
    const label = `${doc.plugin}/skills/${doc.skill}/${relative(doc.skillDir, doc.file)}`;
    it(`${label} references only files reachable from its skill directory`, () => {
      const pluginRoot = join(PLUGINS_DIR, doc.plugin);
      const rel = relative(doc.skillDir, doc.file);
      const ctx: RefContext = {
        skillName: doc.skill,
        inSkill: (ref) => existsSync(join(doc.skillDir, ref)) || existsSync(join(dirname(doc.file), ref)),
        inPluginRoot: (ref) => existsSync(join(pluginRoot, ref)),
        illustrative: ILLUSTRATIVE[`${doc.skill}/${rel}`] ?? [],
      };
      expect(companionProblems(readFileSync(doc.file, "utf-8"), ctx)).toEqual([]);
    });
  }
});
