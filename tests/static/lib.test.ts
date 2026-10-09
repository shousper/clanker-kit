import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { HOOKS_DIR } from "../utils/paths";

const LIB = resolve(HOOKS_DIR, "lib.sh");

// Drive the sourced lib via a tiny bash one-liner so we test real behavior.
async function sh(snippet: string, env: Record<string, string> = {}): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bash", "-c", `. "${LIB}"; ${snippet}`], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { out: await new Response(proc.stdout).text(), code: await proc.exited };
}

describe("lib.sh", () => {
  it("scratch file lives under KIT_STATE_DIR, keyed by KIT_SCRATCH_KEY (no JSON, no CLAUDE_ env)", async () => {
    const r = await sh("kit_scratch_file", { KIT_STATE_DIR: "/tmp/cfgX/kit/state", KIT_SCRATCH_KEY: "A" });
    expect(r.out.trim()).toBe("/tmp/cfgX/kit/state/touched-A.txt");
  });

  it("kit_is_handled accepts source files and rejects others", async () => {
    for (const p of ["/x/a.go", "/x/a.rs", "/x/Cargo.toml", "/x/a.ts", "/x/a.tf", "/x/a.tofu", "/x/a.tfvars", "/x/a.py", "/x/a.pyi", "/x/a.cpp", "/x/a.hpp", "/x/a.h"]) {
      expect((await sh(`kit_is_handled "${p}" && echo Y || echo N`)).out.trim()).toBe("Y");
    }
    for (const p of ["/x/readme.md", "/x/other.toml"]) {
      expect((await sh(`kit_is_handled "${p}" && echo Y || echo N`)).out.trim()).toBe("N");
    }
  });

  it("kit_nearest_dir finds the marker up the tree", async () => {
    const r = await sh(`d=$(mktemp -d); mkdir -p "$d/a/b"; : > "$d/a/Cargo.toml"; kit_nearest_dir "$d/a/b" Cargo.toml; rm -rf "$d"`);
    expect(r.out.trim().endsWith("/a")).toBe(true);
  });

  it("strip_frontmatter drops a leading YAML block and leaves the rest untouched", async () => {
    const r = await sh(`f=$(mktemp); printf -- '---\\nname: x\\ndescription: y\\n---\\n\\nbody line\\n' > "$f"; strip_frontmatter "$f"; rm -f "$f"`);
    expect(r.out).toBe("\nbody line\n");
  });

  it("strip_frontmatter is a no-op when the file has no frontmatter", async () => {
    const r = await sh(`f=$(mktemp); printf 'plain body\\n' > "$f"; strip_frontmatter "$f"; rm -f "$f"`);
    expect(r.out).toBe("plain body\n");
  });
});
