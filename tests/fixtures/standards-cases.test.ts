import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { HOOKS_DIR, KIT_CLAUDE_ROOT, KIT_OMP_ROOT } from "../utils/paths";
import { STANDARDS_CASES } from "./standards-cases";

const FIXTURES = resolve(import.meta.dir);
const GATE = join(HOOKS_DIR, "standards-gate.sh");
const BASH = Bun.which("bash") ?? "bash";

let tmp: string;
let pluginRoot: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "standards-cases-"));
  // Stub standards so the check depends on the fixtures and the gate's language table only.
  pluginRoot = join(tmp, "plugin");
  for (const { lang } of STANDARDS_CASES) {
    await mkdir(join(pluginRoot, "code-standards", lang), { recursive: true });
    await writeFile(join(pluginRoot, "code-standards", lang, "CLAUDE.md"), `# ${lang} stub\n`);
  }
});

afterEach(() => rm(tmp, { recursive: true, force: true }));

async function copyFixture(workspace: string): Promise<string> {
  const cwd = join(tmp, `ws-${workspace}`);
  await cp(join(FIXTURES, `workspace-${workspace}`), cwd, { recursive: true });
  return cwd;
}

describe("standards eval cases", () => {
  for (const c of STANDARDS_CASES) {
    describe(c.lang, () => {
      it("does not already satisfy its prompt, so a pass needs a real edit", async () => {
        expect(await c.landed(await copyFixture(c.workspace))).toBe(false);
      });

      it("targets a file the gate blocks first, naming this language's standards", async () => {
        const cwd = await copyFixture(c.workspace);
        const proc = Bun.spawn([BASH, GATE, "check", join(cwd, c.target)], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, KIT_PLUGIN_ROOT: pluginRoot, KIT_STATE_DIR: join(tmp, "state"), KIT_SCRATCH_KEY: "fixture-check" },
        });
        const [stdout, code] = [await new Response(proc.stdout).text(), await proc.exited];
        expect(code).toBe(2);
        expect(stdout).toContain(join(pluginRoot, "code-standards", c.lang, "CLAUDE.md"));
      });
    });
  }

  it("pins the HCL fixture to OpenTofu so the block names the tool", async () => {
    const cwd = await copyFixture("hcl");
    const proc = Bun.spawn([BASH, GATE, "check", join(cwd, "variables.tf")], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, KIT_PLUGIN_ROOT: pluginRoot, KIT_STATE_DIR: join(tmp, "state"), KIT_SCRATCH_KEY: "fixture-check" },
    });
    expect(await new Response(proc.stdout).text()).toContain("This project uses tofu.");
    await proc.exited;
  });

  it("is backed by real standards in both plugins, never a stub the gate would send an agent to read", async () => {
    for (const root of [KIT_CLAUDE_ROOT, KIT_OMP_ROOT]) {
      for (const { lang } of STANDARDS_CASES) {
        const file = join(root, "code-standards", lang, "CLAUDE.md");
        expect((await stat(file)).size, file).toBeGreaterThan(1_000);
      }
    }
  });
});
