import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { OMP_MARKETPLACE_DIR, REPORTS_OMP_ROOT } from "../utils/paths";

interface Feature {
  description: string;
  default: boolean;
  extensions: string[];
}

const pkg = JSON.parse(readFileSync(resolve(REPORTS_OMP_ROOT, "package.json"), "utf-8")) as {
  name: string;
  version: string;
  private: boolean;
  omp: { extensions?: string[]; features: Record<string, Feature> };
};
const manifest = JSON.parse(readFileSync(resolve(REPORTS_OMP_ROOT, ".omp-plugin/plugin.json"), "utf-8"));
const catalogue = JSON.parse(readFileSync(resolve(OMP_MARKETPLACE_DIR, "marketplace.json"), "utf-8")) as {
  plugins: { name: string; version: string; source: string }[];
};

describe("plugins/reports-omp", () => {
  it("is an OMP-only plugin named reports", () => {
    expect(manifest.name).toBe("reports");
    expect(existsSync(resolve(REPORTS_OMP_ROOT, ".claude-plugin"))).toBe(false);
    expect(pkg.private).toBe(true);
  });

  it("keeps the catalogue, manifest, and package versions in step", () => {
    const entry = catalogue.plugins.find((p) => p.name === "reports");
    expect(entry?.source).toBe("./plugins/reports-omp");
    expect(entry?.version).toBe(manifest.version);
    expect(pkg.version).toBe(manifest.version);
  });

  it("ships every report as an optional feature, none as an always-on extension", () => {
    expect(pkg.omp.extensions).toBeUndefined();
    expect(Object.keys(pkg.omp.features).sort()).toEqual(["skills", "spend", "words"]);
  });

  for (const [feature, spec] of Object.entries(pkg.omp.features)) {
    it(`feature ${feature} registers exactly /reports:${feature}`, async () => {
      expect(spec.extensions).toHaveLength(1);
      const entry = resolve(REPORTS_OMP_ROOT, spec.extensions[0]);
      expect(existsSync(entry)).toBe(true);

      const registered: string[] = [];
      // The path comes from package.json, as it does when omp loads the feature, so it cannot be a static import.
      const factory = (await import(entry)).default as (pi: unknown) => void;
      factory({ registerCommand: (name: string) => registered.push(name), sendMessage: () => {} });
      expect(registered).toEqual([`reports:${feature}`]);
    });
  }
});
