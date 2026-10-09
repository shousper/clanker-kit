import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runHook, runNeutralScript, cleanupHookWorkspace, makeFakeBin, getHclWorkspace, getHookWorkspace } from "../utils/hook-workspace";
import { HOOKS_DIR } from "../utils/paths";

function extractJsonOrNull(stdout: string): any {
  const t = stdout.trim();
  if (!t) return null;
  return JSON.parse(t);
}

afterAll(async () => { await cleanupHookWorkspace(); });
const cfg = () => mkdtemp(join(tmpdir(), "kit-cfg-"));

async function seed(c: string, key: string, paths: string[]) {
  const dir = join(c, "kit/state");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `touched-${key}.txt`), paths.join("\n") + "\n");
}

describe("format-on-stop.sh skeleton", () => {
  it("silent + exit 0 when no scratch", async () => {
    const c = await cfg();
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: "/", session_id: "none", env: { CLAUDE_CONFIG_DIR: c } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    await rm(c, { recursive: true, force: true });
  });

  it("stop_hook_active short-circuits and leaves the scratch intact", async () => {
    const c = await cfg();
    await seed(c, "L", ["/x/a.go"]);
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: "/", session_id: "L", env: { CLAUDE_CONFIG_DIR: c }, stop_hook_active: true });
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(c, "kit/state/touched-L.txt"), "utf-8")).toContain("/x/a.go"); // not consumed
    await rm(c, { recursive: true, force: true });
  });

  it("consumes the scratch and exits silently when no handler produces a finding", async () => {
    const c = await cfg();
    await seed(c, "K", ["/nonexistent/a.go"]); // file doesn't exist -> selected out -> no finding
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: "/", session_id: "K", env: { CLAUDE_CONFIG_DIR: c } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    await expect(readFile(join(c, "kit/state/touched-K.txt"), "utf-8")).rejects.toThrow(); // consumed
    await rm(c, { recursive: true, force: true });
  });
});

describe("format-on-stop.sh: gofmt + rustfmt", () => {
  it("runs gofmt -w on touched .go files only", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    await makeFakeBin(bin, "gofmt");
    const ws = await mkdtemp(join(tmpdir(), "go-"));
    await writeFile(join(ws, "a.go"), "package main\n");
    await writeFile(join(ws, "b.rs"), "fn main(){}\n");
    await seed(c, "g1", [join(ws, "a.go"), join(ws, "b.rs")]);
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws, session_id: "g1", env: { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // formatter success → no finding
    const log = await readFile(join(bin, "gofmt.log"), "utf-8");
    expect(log).toContain("-w");
    expect(log).toContain(join(ws, "a.go"));
    expect(log).not.toContain("b.rs");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  it("runs rustfmt on touched .rs files only", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    await makeFakeBin(bin, "rustfmt");
    const ws = await mkdtemp(join(tmpdir(), "rs-"));
    await writeFile(join(ws, "a.go"), "package main\n");
    await writeFile(join(ws, "b.rs"), "fn main(){}\n");
    await seed(c, "r1", [join(ws, "a.go"), join(ws, "b.rs")]);
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws, session_id: "r1", env: { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // formatter success → no finding
    const log = await readFile(join(bin, "rustfmt.log"), "utf-8");
    expect(log).toContain(join(ws, "b.rs"));
    expect(log).not.toContain("a.go");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });
});

describe("format-on-stop.sh: hcl", () => {
  it("runs fmt on the touched .tf file using the resolved tool", async () => {
    const ws = await getHclWorkspace();
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "tofu"); // fake tofu logs its argv
    const env = { CLAUDE_CONFIG_DIR: c, KIT_STATE_DIR: join(c, "kit/state"), PATH: `${bin}:${process.env.PATH}` };
    // Pre-set the tool so detection is deterministic.
    await runHook("hcl-tool.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, args: ["set", ws.dir, "tofu"], env, dir: HOOKS_DIR });
    // Record an edit via the unified recorder, then format at Stop.
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: join(ws.dir, "main.tf") }, cwd: ws.dir, session_id: "hf1", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "hf1", env });
    expect(r.exitCode).toBe(0);
    const log = (await readFile(join(bin, "tofu.log"), "utf-8")).trim();
    expect(log.split(/\s+/)).toContain("fmt");
    expect(log).toContain(join(ws.dir, "main.tf")); // the specific file, not the bare dir
    // scratch consumed
    await expect(readFile(join(c, "kit/state/touched-hf1.txt"), "utf-8")).rejects.toThrow();
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  it("stays silent when the resolved tool is not installed", async () => {
    const ws = await getHclWorkspace();
    const c = await cfg();
    const emptyBin = await mkdtemp(join(tmpdir(), "emptybin-"));
    const env = { CLAUDE_CONFIG_DIR: c, PATH: emptyBin }; // neither tofu nor terraform on PATH
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: join(ws.dir, "main.tf") }, cwd: ws.dir, session_id: "hni", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "hni", env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // no systemMessage when tool absent
    await rm(c, { recursive: true, force: true });
    await rm(emptyBin, { recursive: true, force: true });
  });

  it("emits the first-detection notice inside the aggregated systemMessage, then is silent", async () => {
    const ws = await getHclWorkspace();
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "tofu");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: join(ws.dir, "main.tf") }, cwd: ws.dir, session_id: "hn1", env });
    const first = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "hn1", env });
    expect(extractJsonOrNull(first.stdout)?.systemMessage ?? "").toContain("/kit:hcl-tool");

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: join(ws.dir, "main.tf") }, cwd: ws.dir, session_id: "hn2", env });
    const second = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "hn2", env });
    expect(extractJsonOrNull(second.stdout)?.systemMessage ?? "").not.toContain("/kit:hcl-tool");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  it("never runs validate, even when .terraform is present", async () => {
    // validate cross-checks config against the last init's provider set, so a
    // provider-affecting edit makes it emit a spurious "Missing required
    // provider" right after an ordinary edit. The handler must not run it.
    const ws = await getHclWorkspace();
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "tofu");
    const env = { CLAUDE_CONFIG_DIR: c, KIT_STATE_DIR: join(c, "kit/state"), PATH: `${bin}:${process.env.PATH}` };
    await runHook("hcl-tool.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, args: ["set", ws.dir, "tofu"], env, dir: HOOKS_DIR });

    // .terraform present (initialized layer) → validate must STILL NOT appear.
    await mkdir(join(ws.dir, ".terraform"), { recursive: true });
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: join(ws.dir, "main.tf") }, cwd: ws.dir, session_id: "hv1", env });
    await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "hv1", env });
    const log = await readFile(join(bin, "tofu.log"), "utf-8");
    expect(log).not.toContain("validate");
    expect(log.split(/\s+/)).toContain("fmt"); // fmt still runs
    await rm(join(ws.dir, ".terraform"), { recursive: true, force: true });
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });
});

describe("format-on-stop.sh: eslint", () => {
  it("runs `npx eslint --fix` on touched js/ts files at Stop; clean run → no finding", async () => {
    const ws = await getHookWorkspace(); // has package.json (eslint dep) + eslint.config.mjs
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "npx"); // logs argv, exits 0
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const f = join(ws.dir, "src", "a.ts");
    await writeFile(f, "export const x = 1;\n");

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: f }, cwd: ws.dir, session_id: "es1", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "es1", env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // clean → no finding, no decision:block
    const log = await readFile(join(bin, "npx.log"), "utf-8");
    expect(log).toContain("eslint");
    expect(log).toContain("--fix");
    expect(log).toContain(f);
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(f, { force: true });
  });

  it("surfaces eslint lint output as a non-blocking finding (never decision:block)", async () => {
    const ws = await getHookWorkspace();
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    // Fake npx: emulate eslint reporting a lint issue (exit 1 with output).
    await makeFakeBin(bin, "npx",
      `#!/usr/bin/env bash\necho "$@" >> "${join(bin, "npx.log")}"\necho "  1:7  error  'unused' is assigned a value but never used  no-unused-vars"\nexit 1\n`);
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const f = join(ws.dir, "src", "dirty.ts");
    await writeFile(f, "const unused = 1;\n");

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: f }, cwd: ws.dir, session_id: "es2", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "es2", env });
    expect(r.exitCode).toBe(0);
    const j = extractJsonOrNull(r.stdout);
    expect(j).not.toBeNull();
    expect(j.suppressOutput).toBe(true);
    expect(j.decision ?? "").not.toBe("block"); // non-blocking
    expect(j.systemMessage).toContain("no-unused-vars");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(f, { force: true });
  });

  it("silently skips when no eslint config/dep is reachable", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "npx");
    // A bare temp dir with no package.json / eslint config.
    const proj = await mkdtemp(join(tmpdir(), "noeslint-"));
    await mkdir(join(proj, "src"), { recursive: true });
    const f = join(proj, "src", "x.ts");
    await writeFile(f, "export const x = 1;\n");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: f }, cwd: proj, session_id: "es3", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: proj, session_id: "es3", env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    // npx must not have been invoked for eslint.
    await expect(readFile(join(bin, "npx.log"), "utf-8")).rejects.toThrow();
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });
});

describe("format-on-stop.sh: tsc", () => {
  it("runs `npx tsc --noEmit` once per tsconfig project; clean → no finding", async () => {
    const ws = await getHookWorkspace(); // package.json (typescript dep) + tsconfig.json
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "npx"); // logs argv, exits 0
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const a = join(ws.dir, "src", "ta.ts");
    const b = join(ws.dir, "src", "tb.ts");
    await writeFile(a, "export const a = 1;\n");
    await writeFile(b, "export const b = 2;\n");

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: a }, cwd: ws.dir, session_id: "ts1", env });
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: b }, cwd: ws.dir, session_id: "ts1", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "ts1", env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // clean → no finding
    const log = await readFile(join(bin, "npx.log"), "utf-8");
    // tsc invoked once for the single project (two files, one tsconfig).
    const tscRuns = log.split("\n").filter((l) => l.includes("tsc")).length;
    expect(tscRuns).toBe(1);
    expect(log).toContain("--noEmit");
    expect(log).toContain("--pretty false");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(a, { force: true }); await rm(b, { force: true });
  });

  it("surfaces tsc errors as a non-blocking finding (never decision:block)", async () => {
    const ws = await getHookWorkspace();
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "npx",
      `#!/usr/bin/env bash\necho "$@" >> "${join(bin, "npx.log")}"\necho "src/broken.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'."\nexit 2\n`);
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const f = join(ws.dir, "src", "broken.ts");
    await writeFile(f, 'const x: number = "no";\n');

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: f }, cwd: ws.dir, session_id: "ts2", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "ts2", env });
    expect(r.exitCode).toBe(0);
    const j = extractJsonOrNull(r.stdout);
    expect(j).not.toBeNull();
    expect(j.decision ?? "").not.toBe("block");
    expect(j.systemMessage).toContain("TS2322");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(f, { force: true });
  });
});

describe("format-on-stop.sh: rust-checks", () => {
  it("runs cargo check + clippy once per crate (two files in one crate → one pair)", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "cargo"); // logs argv, exits 0
    const crate = await mkdtemp(join(tmpdir(), "crate-"));
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='x'\n");
    await mkdir(join(crate, "src"), { recursive: true });
    const a = join(crate, "src", "a.rs");
    const b = join(crate, "src", "b.rs");
    await writeFile(a, "fn a() {}\n");
    await writeFile(b, "fn b() {}\n");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: a }, cwd: crate, session_id: "rc1", env });
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: b }, cwd: crate, session_id: "rc1", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: crate, session_id: "rc1", env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // clean → no finding
    const log = await readFile(join(bin, "cargo.log"), "utf-8");
    const checks = log.split("\n").filter((l) => l.startsWith("check")).length;
    const clippys = log.split("\n").filter((l) => l.startsWith("clippy")).length;
    expect(checks).toBe(1); // de-duped per crate
    expect(clippys).toBe(1);
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(crate, { recursive: true, force: true });
  });

  it("passes `-D warnings` to clippy when clippy.toml is present", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "cargo");
    const crate = await mkdtemp(join(tmpdir(), "crate-"));
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='x'\n");
    await writeFile(join(crate, "clippy.toml"), "msrv = \"1.70\"\n");
    await mkdir(join(crate, "src"), { recursive: true });
    const a = join(crate, "src", "a.rs");
    await writeFile(a, "fn a() {}\n");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: a }, cwd: crate, session_id: "rc2", env });
    await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: crate, session_id: "rc2", env });
    const log = await readFile(join(bin, "cargo.log"), "utf-8");
    expect(log).toContain("-D warnings");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(crate, { recursive: true, force: true });
  });

  it("surfaces cargo failures as a non-blocking finding (never decision:block)", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    // Fake cargo: emulate a compile error (exit 101 with output).
    await makeFakeBin(bin, "cargo",
      `#!/usr/bin/env bash\necho "$@" >> "${join(bin, "cargo.log")}"\necho "error[E0425]: cannot find value \\\`foo\\\` in this scope" >&2\nexit 101\n`);
    const crate = await mkdtemp(join(tmpdir(), "crate-"));
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='x'\n");
    await mkdir(join(crate, "src"), { recursive: true });
    const a = join(crate, "src", "a.rs");
    await writeFile(a, "fn a() { foo }\n");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: a }, cwd: crate, session_id: "rc3", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: crate, session_id: "rc3", env });
    expect(r.exitCode).toBe(0);
    const j = extractJsonOrNull(r.stdout);
    expect(j).not.toBeNull();
    expect(j.decision ?? "").not.toBe("block");
    expect(j.systemMessage).toContain("E0425");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(crate, { recursive: true, force: true });
  });

  it("skips silently when cargo is absent", async () => {
    const c = await cfg();
    const emptyBin = await mkdtemp(join(tmpdir(), "emptybin-"));
    const crate = await mkdtemp(join(tmpdir(), "crate-"));
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='x'\n");
    await mkdir(join(crate, "src"), { recursive: true });
    const a = join(crate, "src", "a.rs");
    await writeFile(a, "fn a() {}\n");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: emptyBin }; // no cargo on PATH

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: a }, cwd: crate, session_id: "rc4", env });
    const r = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: crate, session_id: "rc4", env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    await rm(c, { recursive: true, force: true });
    await rm(emptyBin, { recursive: true, force: true });
    await rm(crate, { recursive: true, force: true });
  });
});

describe("format-files.sh (neutral: args/env in, plain text out, no JSON)", () => {
  it("silent + exit 0 for no files", async () => {
    const r = await runNeutralScript("format-files.sh");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("formats a touched .go file given directly as an argument, no JSON anywhere", async () => {
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    await makeFakeBin(bin, "gofmt");
    const ws = await mkdtemp(join(tmpdir(), "go-"));
    const f = join(ws, "a.go");
    await writeFile(f, "package main\n");
    const r = await runNeutralScript("format-files.sh", { args: [f], cwd: ws, env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // formatter success → no finding
    expect(r.stdout).not.toContain("{"); // never JSON
    const log = await readFile(join(bin, "gofmt.log"), "utf-8");
    expect(log).toContain("-w");
    expect(log).toContain(f);
    await rm(bin, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  it("surfaces a finding as plain text (never JSON-wrapped)", async () => {
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    await makeFakeBin(bin, "npx",
      `#!/usr/bin/env bash\necho "$@" >> "${join(bin, "npx.log")}"\necho "  1:7  error  'unused' is assigned a value but never used  no-unused-vars"\nexit 1\n`);
    const ws = await getHookWorkspace();
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const f = join(ws.dir, "src", "dirty.ts");
    await writeFile(f, "const unused = 1;\n");
    const r = await runNeutralScript("format-files.sh", { args: [f], cwd: ws.dir, env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no-unused-vars");
    expect(r.stdout).not.toContain("{"); // plain text, not JSON
    await rm(bin, { recursive: true, force: true });
    await rm(f, { force: true });
  });
});

// Stub that logs "<physical cwd> <argv>" per call to <dir>/<name>.log.
const cwdLoggingBody = (dir: string, name: string, extra = "") =>
  `#!/usr/bin/env bash\necho "$(pwd -P) $*" >> "${join(dir, `${name}.log`)}"\n${extra}exit 0\n`;

async function logLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf-8")).split("\n").filter(Boolean);
}

async function stopWith(c: string, ws: string, id: string, files: string[], path: string) {
  const env = { CLAUDE_CONFIG_DIR: c, PATH: path };
  for (const f of files) {
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: f }, cwd: ws, session_id: id, env });
  }
  return runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws, session_id: id, env });
}

// A shim on PATH can exist yet fail (for example a version manager with no version set).
const hasWorkingRuff = Bun.which("ruff") !== null && Bun.spawnSync(["ruff", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe("format-on-stop.sh: ruff", () => {
  async function setup(configFile: { name: string; body: string }) {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "ruff", cwdLoggingBody(bin, "ruff"));
    const ws = await realpath(await mkdtemp(join(tmpdir(), "py-")));
    await writeFile(join(ws, configFile.name), configFile.body);
    await mkdir(join(ws, "src"), { recursive: true });
    const app = join(ws, "src", "app.py");
    await writeFile(app, "import os\n");
    const done = async () => {
      await rm(c, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    };
    return { c, bin, ws, app, done };
  }

  it("runs ruff format then ruff check --fix in the configured project", async () => {
    const t = await setup({ name: "pyproject.toml", body: "[tool.ruff]\nline-length = 100\n" });
    const r = await stopWith(t.c, t.ws, "ru1", [t.app], `${t.bin}:${process.env.PATH}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(await logLines(join(t.bin, "ruff.log"))).toEqual([
      `${t.ws} format --force-exclude ${t.app}`,
      `${t.ws} check --fix --force-exclude --output-format concise ${t.app}`,
    ]);
    await t.done();
  });

  for (const name of ["ruff.toml", ".ruff.toml"]) {
    it(`is enabled by ${name}`, async () => {
      const t = await setup({ name, body: "line-length = 100\n" });
      await stopWith(t.c, t.ws, "ru2", [t.app], `${t.bin}:${process.env.PATH}`);
      expect(await logLines(join(t.bin, "ruff.log"))).toHaveLength(2);
      await t.done();
    });
  }

  it("does nothing when pyproject.toml has no [tool.ruff] table", async () => {
    const t = await setup({ name: "pyproject.toml", body: "[tool.black]\nline-length = 100\n" });
    const r = await stopWith(t.c, t.ws, "ru3", [t.app], `${t.bin}:${process.env.PATH}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    await expect(readFile(join(t.bin, "ruff.log"), "utf-8")).rejects.toThrow();
    await t.done();
  });

  it("prefers the project .venv/bin/ruff over PATH", async () => {
    const t = await setup({ name: "pyproject.toml", body: "[tool.ruff]\n" });
    const venvBin = join(t.ws, ".venv", "bin");
    await mkdir(venvBin, { recursive: true });
    await makeFakeBin(venvBin, "ruff", cwdLoggingBody(venvBin, "ruff"));
    await stopWith(t.c, t.ws, "ru4", [t.app], `${t.bin}:${process.env.PATH}`);
    expect(await logLines(join(venvBin, "ruff.log"))).toHaveLength(2);
    await expect(readFile(join(t.bin, "ruff.log"), "utf-8")).rejects.toThrow();
    await t.done();
  });

  it("surfaces ruff check findings in the summary", async () => {
    const t = await setup({ name: "pyproject.toml", body: "[tool.ruff]\n" });
    await makeFakeBin(t.bin, "ruff",
      `#!/usr/bin/env bash\nif [ "$1" = check ]; then echo "src/app.py:1:1: F401 unused import"; exit 1; fi\nexit 0\n`);
    const r = await stopWith(t.c, t.ws, "ru5", [t.app], `${t.bin}:${process.env.PATH}`);
    expect(r.exitCode).toBe(0);
    const j = extractJsonOrNull(r.stdout);
    expect(j.decision ?? "").not.toBe("block");
    expect(j.systemMessage).toContain("ruff reported issues:");
    expect(j.systemMessage).toContain("src/app.py:1:1: F401 unused import");
    await t.done();
  });

  it("runs ruff once per project with every touched file", async () => {
    const t = await setup({ name: "pyproject.toml", body: "[tool.ruff]\n" });
    const other = join(t.ws, "src", "util.py");
    await writeFile(other, "x = 1\n");
    await stopWith(t.c, t.ws, "ru6", [t.app, other], `${t.bin}:${process.env.PATH}`);
    const lines = await logLines(join(t.bin, "ruff.log"));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain(t.app);
      expect(l).toContain(other);
    }
    await t.done();
  });

  it.skipIf(!hasWorkingRuff)("leaves files the project excludes untouched", async () => {
    const t = await setup({ name: "pyproject.toml", body: '[tool.ruff]\nextend-exclude = ["gen"]\n' });
    const gen = join(t.ws, "gen", "x_pb2.py");
    await mkdir(join(t.ws, "gen"), { recursive: true });
    const generated = "import os\nx=[1,2,\n3]\n";
    await writeFile(gen, generated);
    await writeFile(t.app, "y=[1,2,\n3]\n");
    // Real ruff: drop the stub from PATH.
    await rm(join(t.bin, "ruff"));
    await stopWith(t.c, t.ws, "ru7", [gen, t.app], `${t.bin}:${process.env.PATH}`);
    expect(await readFile(gen, "utf-8")).toBe(generated);
    expect(await readFile(t.app, "utf-8")).toBe("y = [1, 2, 3]\n");
    await t.done();
  });
});

describe("format-on-stop.sh: clang-format", () => {
  async function setup(styleFile: string | null) {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "clang-format");
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cpp-")));
    if (styleFile) await writeFile(join(ws, styleFile), "BasedOnStyle: LLVM\n");
    await mkdir(join(ws, "src"), { recursive: true });
    await mkdir(join(ws, "include"), { recursive: true });
    const cpp = join(ws, "src", "main.cpp");
    const hdr = join(ws, "include", "app.h");
    await writeFile(cpp, "int main(){}\n");
    await writeFile(hdr, "#pragma once\n");
    const done = async () => {
      await rm(c, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    };
    return { c, bin, ws, cpp, hdr, done };
  }

  for (const styleFile of [".clang-format", "_clang-format"]) {
    it(`runs clang-format -i on touched files when an ancestor has ${styleFile}`, async () => {
      const t = await setup(styleFile);
      const r = await stopWith(t.c, t.ws, "cf1", [t.cpp, t.hdr], `${t.bin}:${process.env.PATH}`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
      const lines = await logLines(join(t.bin, "clang-format.log"));
      expect(lines).toHaveLength(1);
      const [flag, ...files] = lines[0].split(" ");
      expect(flag).toBe("-i");
      expect(files.sort()).toEqual([t.cpp, t.hdr].sort());
      await t.done();
    });
  }

  // Stub git-clang-format: logs "<cwd> <argv>" per call, refuses (exit 2) to touch a file with
  // unstaged changes unless --force is given (as the real tool does), and "formats" a file by
  // appending a marker line.
  const gitClangFormatStub = (bin: string) => `#!/usr/bin/env bash
echo "$(pwd -P) $*" >> "${join(bin, "git-clang-format.log")}"
force=""; files=(); after=""
for a in "$@"; do
  if [ -n "$after" ]; then files+=("$a"); elif [ "$a" = "--" ]; then after=1; elif [ "$a" = "--force" ]; then force=1; fi
done
if [ -z "$force" ]; then
  for f in "\${files[@]}"; do
    git diff --quiet -- "$f" || { echo "error: $f would be modified but has unstaged changes" >&2; exit 2; }
  done
fi
for f in "\${files[@]}"; do echo "// formatted" >> "$f"; done
exit 0
`;
  const gitIn = (dir: string, ...args: string[]) =>
    Bun.spawn(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "ignore", stderr: "ignore" }).exited;

  it("formats only changed lines of edited tracked files with git clang-format", async () => {
    const t = await setup(".clang-format");
    await makeFakeBin(t.bin, "git-clang-format", gitClangFormatStub(t.bin));
    const second = join(t.ws, "src", "util.cpp");
    await writeFile(second, "int util(){}\n");
    await gitIn(t.ws, "init", "-q");
    await gitIn(t.ws, "add", "src/main.cpp", "src/util.cpp");
    await gitIn(t.ws, "commit", "-q", "-m", "init");
    // The agent's edits are unstaged.
    await writeFile(t.cpp, "int main(){return 0;}\n");
    await writeFile(second, "int util(){return 1;}\n");
    const r = await stopWith(t.c, t.ws, "cf3", [t.cpp, second, t.hdr], `${t.bin}:${process.env.PATH}`);
    expect(r.exitCode).toBe(0);
    expect(await readFile(t.cpp, "utf-8")).toContain("// formatted");
    expect(await readFile(second, "utf-8")).toContain("// formatted");
    const tracked = await logLines(join(t.bin, "git-clang-format.log"));
    expect(tracked).toHaveLength(1);
    expect(tracked[0].startsWith(`${t.ws} `)).toBe(true);
    expect(tracked[0]).toContain("src/main.cpp");
    expect(tracked[0]).toContain("src/util.cpp");
    const whole = await logLines(join(t.bin, "clang-format.log"));
    expect(whole).toEqual([`-i ${t.hdr}`]);
    await t.done();
  });

  it("runs git clang-format once per repository", async () => {
    const t = await setup(".clang-format");
    await makeFakeBin(t.bin, "git-clang-format", gitClangFormatStub(t.bin));
    const inner = join(t.ws, "vendor", "lib");
    await mkdir(inner, { recursive: true });
    const innerCpp = join(inner, "lib.cpp");
    await writeFile(innerCpp, "int lib(){}\n");
    for (const [dir, file] of [[t.ws, "src/main.cpp"], [inner, "lib.cpp"]]) {
      await gitIn(dir, "init", "-q");
      await gitIn(dir, "add", file);
      await gitIn(dir, "commit", "-q", "-m", "init");
    }
    await writeFile(t.cpp, "int main(){return 0;}\n");
    await writeFile(innerCpp, "int lib(){return 0;}\n");
    await stopWith(t.c, t.ws, "cf4", [t.cpp, innerCpp], `${t.bin}:${process.env.PATH}`);
    expect(await readFile(t.cpp, "utf-8")).toContain("// formatted");
    expect(await readFile(innerCpp, "utf-8")).toContain("// formatted");
    const lines = await logLines(join(t.bin, "git-clang-format.log"));
    expect(lines.map((l) => l.split(" ")[0]).sort()).toEqual([t.ws, inner].sort());
    await t.done();
  });

  it.skipIf(Bun.which("git-clang-format") !== null)("leaves tracked files alone when git-clang-format is not installed", async () => {
    const t = await setup(".clang-format");
    await gitIn(t.ws, "init", "-q");
    await gitIn(t.ws, "add", "src/main.cpp");
    await gitIn(t.ws, "commit", "-q", "-m", "init");
    await writeFile(t.cpp, "int main(){return 0;}\n");
    const r = await stopWith(t.c, t.ws, "cf5", [t.cpp, t.hdr], `${t.bin}:${process.env.PATH}`);
    expect(r.exitCode).toBe(0);
    const whole = await logLines(join(t.bin, "clang-format.log"));
    expect(whole).toEqual([`-i ${t.hdr}`]);
    await t.done();
  });

  it("does nothing without a clang-format config", async () => {
    const t = await setup(null);
    const r = await stopWith(t.c, t.ws, "cf2", [t.cpp, t.hdr], `${t.bin}:${process.env.PATH}`);
    expect(r.exitCode).toBe(0);
    await expect(readFile(join(t.bin, "clang-format.log"), "utf-8")).rejects.toThrow();
    await t.done();
  });
});

describe("format-on-stop.sh: KIT_FORMAT_SKIP", () => {
  // One workspace with a Go, a Python and a C++ file; every handler has a stub and a config.
  async function setup() {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "gofmt");
    await makeFakeBin(bin, "ruff", cwdLoggingBody(bin, "ruff", 'echo "x.py:1:1: F401 unused" >&2\nexit 1\n'));
    await makeFakeBin(bin, "clang-format");
    const ws = await realpath(await mkdtemp(join(tmpdir(), "skip-")));
    await writeFile(join(ws, "pyproject.toml"), "[tool.ruff]\n");
    await writeFile(join(ws, ".clang-format"), "BasedOnStyle: LLVM\n");
    const files = [join(ws, "a.go"), join(ws, "b.py"), join(ws, "c.cpp")];
    for (const f of files) await writeFile(f, "x\n");
    const run = async (id: string, skip?: string) => {
      const env: Record<string, string> = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };
      if (skip !== undefined) env.KIT_FORMAT_SKIP = skip;
      const r = await stopWith2(c, ws, id, files, env);
      const ran = async (n: string) => (await readFile(join(bin, `${n}.log`), "utf-8").catch(() => "")) !== "";
      return { r, gofmt: await ran("gofmt"), ruff: await ran("ruff"), clang: await ran("clang-format") };
    };
    const done = async () => {
      await rm(c, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    };
    return { run, done };
  }

  async function stopWith2(c: string, ws: string, id: string, files: string[], env: Record<string, string>) {
    for (const f of files) {
      await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: f }, cwd: ws, session_id: id, env });
    }
    return runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws, session_id: id, env });
  }

  it("runs every handler when the variable is unset", async () => {
    const t = await setup();
    const o = await t.run("s0");
    expect([o.gofmt, o.ruff, o.clang]).toEqual([true, true, true]);
    expect(o.r.stdout).toContain("ruff reported issues");
    await t.done();
  });

  it("skips ruff while gofmt still runs", async () => {
    const t = await setup();
    const o = await t.run("s1", "ruff");
    expect([o.gofmt, o.ruff, o.clang]).toEqual([true, false, true]);
    expect(o.r.stdout.trim()).toBe("");
    await t.done();
  });

  it("skips a comma-separated list", async () => {
    const t = await setup();
    const o = await t.run("s2", "gofmt,clang_format");
    expect([o.gofmt, o.ruff, o.clang]).toEqual([false, true, false]);
    await t.done();
  });

  it("skips a space-separated list", async () => {
    const t = await setup();
    const o = await t.run("s3", "gofmt clang_format");
    expect([o.gofmt, o.ruff, o.clang]).toEqual([false, true, false]);
    await t.done();
  });

  it("skips every handler and prints nothing for all", async () => {
    const t = await setup();
    const o = await t.run("s4", "all");
    expect([o.gofmt, o.ruff, o.clang]).toEqual([false, false, false]);
    expect(o.r.exitCode).toBe(0);
    expect(o.r.stdout.trim()).toBe("");
    await t.done();
  });

  it("ignores an unknown name", async () => {
    const t = await setup();
    const o = await t.run("s5", "black");
    expect([o.gofmt, o.ruff, o.clang]).toEqual([true, true, true]);
    await t.done();
  });
});
