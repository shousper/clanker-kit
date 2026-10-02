import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { KIT_OMP_ROOT } from "../utils/paths";

const PACKAGE_JSON_PATH = resolve(KIT_OMP_ROOT, "package.json");
const INDEX_PATH = resolve(KIT_OMP_ROOT, "omp/index.ts");
const HOOKS_PATH = resolve(KIT_OMP_ROOT, "omp/hooks.ts");
const PLUGIN_JSON_PATH = resolve(KIT_OMP_ROOT, ".omp-plugin/plugin.json");
const PROFILE_PATH = resolve(KIT_OMP_ROOT, "omp/harness-profile.md");

describe("plugins/kit-omp/package.json", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));

  it("stays inert metadata (private, no scripts Claude Code would run)", () => {
    expect(pkg.name).toBe("kit-omp");
    expect(pkg.private).toBe(true);
  });

  it("declares omp.extensions entries that exist on disk", () => {
    const entries: string[] = pkg.omp?.extensions ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(existsSync(resolve(KIT_OMP_ROOT, entry))).toBe(true);
    }
  });

  it("points at omp/index.ts", () => {
    expect(pkg.omp.extensions).toContain("./omp/index.ts");
  });
});

describe("plugins/kit-omp/.omp-plugin/plugin.json", () => {
  it("exists and declares the shared plugin name", () => {
    expect(existsSync(PLUGIN_JSON_PATH)).toBe(true);
    const manifest = JSON.parse(readFileSync(PLUGIN_JSON_PATH, "utf-8"));
    expect(manifest.name).toBe("kit");
  });

  it("carries no .claude-plugin manifest dir — this is an OMP-only plugin", () => {
    expect(existsSync(resolve(KIT_OMP_ROOT, ".claude-plugin"))).toBe(false);
  });
});

describe("plugins/kit-omp/omp/index.ts", () => {
  const source = readFileSync(INDEX_PATH, "utf-8");

  it("default-exports an extension factory", () => {
    expect(source).toMatch(/export default function/);
  });

  it("wires in the native OMP hooks — its only job", () => {
    expect(source).toMatch(/registerHooks/);
  });

  it("never references the deleted Claude-protocol bridge", () => {
    expect(source).not.toMatch(/hook-?[Bb]ridge/);
  });

  it("never references the deleted harness-profile vocabulary injection", () => {
    expect(source).not.toMatch(/harness-profile/);
  });
});

describe("plugins/kit-omp/omp/hooks.ts", () => {
  const source = readFileSync(HOOKS_PATH, "utf-8");

  it("registers native pi.on(...) handlers, not a Claude-protocol bridge", () => {
    expect(source).toMatch(/export function registerHooks/);
    expect(source).not.toMatch(/hook-?[Bb]ridge/);
  });

  it("carries no Claude hook protocol", () => {
    expect(source).not.toMatch(/CLAUDE_|\.claude(?:-|\/|$)/);
    expect(source).not.toMatch(/hookSpecificOutput|systemMessage|permissionDecision|suppressOutput/);
  });
});

describe("plugins/kit-omp/omp/harness-profile.md", () => {
  it("no longer exists — the harness's own system prompt already teaches its tools", () => {
    expect(existsSync(PROFILE_PATH)).toBe(false);
  });
});
