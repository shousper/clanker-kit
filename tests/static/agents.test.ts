import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import { extractFrontmatter } from "../utils/skill-parser";
import { AGENTS_DIR, KIT_CLAUDE_ROOT, KIT_OMP_ROOT, STORIES_CLAUDE_ROOT, STORIES_OMP_ROOT } from "../utils/paths";

const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));

const agents = agentFiles.map((file) => {
  const raw = readFileSync(resolve(AGENTS_DIR, file), "utf-8");
  const { frontmatter, body } = extractFrontmatter(raw);
  return { file, frontmatter, body };
});

describe("agent definitions", () => {
  it("can load all agent definitions", () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it("each agent has name and description in frontmatter", () => {
    for (const { file, frontmatter } of agents) {
      expect(typeof frontmatter.name, `${file}: name should be string`).toBe("string");
      expect((frontmatter.name as string).length, `${file}: name should not be empty`).toBeGreaterThan(0);
      expect(typeof frontmatter.description, `${file}: description should be string`).toBe("string");
      expect((frontmatter.description as string).length, `${file}: description should not be empty`).toBeGreaterThan(0);
    }
  });

  it("agent name matches filename", () => {
    for (const { file, frontmatter } of agents) {
      expect(frontmatter.name).toBe(basename(file, ".md"));
    }
  });

  it("each agent has non-empty markdown body", () => {
    for (const { file, body } of agents) {
      expect(body.trim().length).toBeGreaterThan(0);
    }
  });
});

// Each harness ships the same agents with its own frontmatter: Claude pins model and effort,
// OMP resolves built-in roles (tests/static/neutral-prose.test.ts). Workflows name the agent
// and never set a model per call, so this frontmatter is the model choice.
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS = ["sonnet", "opus", "haiku", "fable"];
const NATIVE: [string, string, string, string, string][] = [
  [KIT_CLAUDE_ROOT, KIT_OMP_ROOT, "kit-worker", "sonnet", "high"],
  [KIT_CLAUDE_ROOT, KIT_OMP_ROOT, "kit-verifier", "sonnet", "low"],
  [KIT_CLAUDE_ROOT, KIT_OMP_ROOT, "kit-arbiter", "opus", "xhigh"],
  [STORIES_CLAUDE_ROOT, STORIES_OMP_ROOT, "story-planner-routine", "sonnet", "high"],
  [STORIES_CLAUDE_ROOT, STORIES_OMP_ROOT, "story-planner-hard", "opus", "xhigh"],
  [STORIES_CLAUDE_ROOT, STORIES_OMP_ROOT, "story-planner-frontier", "fable", "xhigh"],
];

describe("native Claude agents", () => {
  it.each(NATIVE)("%s/agents/%s.md pins model and effort, with an OMP twin", (claudeRoot, ompRoot, name, model, effort) => {
    const { frontmatter, body } = extractFrontmatter(readFileSync(resolve(claudeRoot, "agents", `${name}.md`), "utf-8"));
    expect(frontmatter.name).toBe(name);
    expect(typeof frontmatter.description).toBe("string");
    expect(frontmatter.model).toBe(model);
    expect(frontmatter.effort).toBe(effort);
    expect(CLAUDE_MODELS).toContain(frontmatter.model as string);
    expect(CLAUDE_EFFORTS).toContain(frontmatter.effort as string);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(existsSync(resolve(ompRoot, "agents", `${name}.md`))).toBe(true);
  });

  it("kit-claude still ships the shared code-reviewer agent", () => {
    expect(existsSync(resolve(KIT_CLAUDE_ROOT, "agents", "code-reviewer.md"))).toBe(true);
  });
});
