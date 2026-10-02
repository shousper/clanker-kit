import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { basename, resolve } from "path";
import { KIT_CLAUDE_HOOKS_DIR, ROOT } from "../utils/paths";

const README = readFileSync(resolve(ROOT, "README.md"), "utf-8");

const RETIRED = [
  "gofmt.sh", "rustfmt.sh", "eslint.sh", "typescript.sh",
  "clippy.sh", "cargo-check.sh", "hcl-record.sh", "hcl-fmt.sh",
];

describe("README.md hooks documentation", () => {
  it("documents the unified pipeline scripts", () => {
    expect(README).toContain("record.sh");
    expect(README).toContain("format-on-stop.sh");
  });

  it("documents every hook script that hooks.json registers", () => {
    const registry = JSON.parse(readFileSync(resolve(KIT_CLAUDE_HOOKS_DIR, "hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const scripts = new Set(
      Object.values(registry.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((hook) => basename(hook.command)))),
    );
    expect(scripts.size).toBeGreaterThan(0);
    for (const script of scripts) expect(README, `README.md does not document hooks/${script}`).toContain(script);
  });

  it("does not reference any retired per-edit script", () => {
    for (const dead of RETIRED) {
      expect(README).not.toContain(dead);
    }
  });
});
