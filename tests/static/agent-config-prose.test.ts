import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ROOT } from "../utils/paths";

// Agents that read how to change model configuration change it, often persistently and
// without being asked: session history from 2026-09 to 2026-11 shows build-flow agents
// rerouting kit-* agents after a rate limit, and one saved override breaking a later run
// in another project. Model choice is the user's, so no text an agent reads names the
// settings that pin models. User-facing README files are exempt.
const FORBIDDEN = /agentModelOverrides|modelRoles|omp config set|cfg:\/\/(?:modelRoles|task)/;

const SURFACES = [
  "plugins/*/agents/*.md",
  "shared/agents/*.md",
  "plugins/*/skills/**/*.{md,js,mjs}",
  "shared/skills/**/*.md",
  "shared/stories/skills/**/*.md",
  "plugins/*/omp/**/*.ts",
  "shared/hooks/*.sh",
];

function surfaceFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of SURFACES) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT, followSymlinks: true })) {
      if (!file.endsWith("README.md")) files.add(file);
    }
  }
  return [...files].sort();
}

describe("agent-facing text never names model-config settings", () => {
  const files = surfaceFiles();

  it("scans the agent, skill, workflow, and hook surfaces", () => {
    expect(files).toContain("plugins/kit-omp/agents/kit-worker.md");
    expect(files).toContain("plugins/kit-omp/skills/build-flow/launch.md");
    expect(files).toContain("plugins/stories-omp/skills/work/plan.workflow.mjs");
    expect(files).toContain("plugins/stories-omp/omp/hooks.ts");
  });

  it.each(files)("%s", (file) => {
    const text = readFileSync(resolve(ROOT, file), "utf-8");
    expect(FORBIDDEN.exec(text)?.[0]).toBeUndefined();
  });
});
