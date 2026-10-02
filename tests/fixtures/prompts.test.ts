import { describe, it, expect } from "bun:test";
import { readdirSync } from "fs";
import { activationTests } from "./prompts";
import { SKILLS_DIR, STORIES_SKILLS_DIR, WRITING_SKILLS_DIR } from "../utils/paths";

// Activation names as the harnesses report them: kit skills are bare, the stories and
// writing plugins are namespaced.
const SHIPPED_SKILLS = new Set([
  ...readdirSync(SKILLS_DIR),
  ...readdirSync(STORIES_SKILLS_DIR).map((name) => `stories:${name}`),
  ...readdirSync(WRITING_SKILLS_DIR).map((name) => `writing:${name}`),
]);

describe("activationTests", () => {
  it("flattens to ActivationTest[] with correct fields", () => {
    expect(activationTests.length).toBeGreaterThan(0);
    for (const test of activationTests) {
      expect(test).toHaveProperty("skill");
      expect(test).toHaveProperty("prompt");
      expect(test).toHaveProperty("shouldActivate");
      expect(typeof test.skill).toBe("string");
      expect(typeof test.prompt).toBe("string");
      expect(typeof test.shouldActivate).toBe("boolean");
    }
  });

  it("preserves session context on entries that have it", () => {
    const withSession = activationTests.filter((t) => t.sessionContext);
    expect(withSession.length).toBeGreaterThan(0);
    for (const test of withSession) {
      expect(["cold-start", "post-brainstorm", "mid-session"]).toContain(test.sessionContext);
    }
  });

  it("preserves workspace on entries that have it", () => {
    const withWorkspace = activationTests.filter((t) => t.workspace);
    expect(withWorkspace.length).toBeGreaterThan(0);
    for (const test of withWorkspace) {
      expect(["go", "rust", "tailwind", "stories", "writing"]).toContain(test.workspace);
    }
  });

  it("only targets skills that ship, so a retired skill cannot linger as an unreachable eval", () => {
    const targeted = new Set(activationTests.map((t) => t.skill));
    for (const skill of targeted) expect(SHIPPED_SKILLS.has(skill), `fixtures target unknown skill ${skill}`).toBe(true);
  });

  it("includes stories plugin fixtures for all five skills", () => {
    const storySkills = [
      "stories:setup",
      "stories:plan",
      "stories:work",
      "stories:cancel",
      "stories:using-stories",
    ];
    for (const skill of storySkills) {
      const entries = activationTests.filter((t) => t.skill === skill);
      const positive = entries.filter((t) => t.shouldActivate);
      const negative = entries.filter((t) => !t.shouldActivate);
      expect(positive.length).toBeGreaterThanOrEqual(3);
      expect(negative.length).toBeGreaterThanOrEqual(3);
    }
  });
});
