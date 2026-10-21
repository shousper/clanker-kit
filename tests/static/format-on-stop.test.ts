import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
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

describe("format-on-stop.sh: no project compiles", () => {
  it("does not run tsc when a TypeScript file was edited", async () => {
    const ws = await getHookWorkspace();
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "npx");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const file = join(ws.dir, "src", "ta.ts");
    await writeFile(file, "export const a = 1;\n");

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: file }, cwd: ws.dir, session_id: "ts1", env });
    const result = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: ws.dir, session_id: "ts1", env });

    expect(result.exitCode).toBe(0);
    const log = await readFile(join(bin, "npx.log"), "utf-8").catch(() => "");
    expect(log).not.toContain("tsc");
    expect(log).not.toContain("--noEmit");
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(file, { force: true });
  });

  it("does not run cargo check or clippy when a Rust file was edited, and still rustfmts", async () => {
    const c = await cfg();
    const bin = await mkdtemp(join(tmpdir(), "fakebin-"));
    await makeFakeBin(bin, "cargo");
    await makeFakeBin(bin, "rustfmt");
    const crate = await mkdtemp(join(tmpdir(), "crate-"));
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='x'\n");
    await writeFile(join(crate, "clippy.toml"), "msrv = \"1.70\"\n");
    await mkdir(join(crate, "src"), { recursive: true });
    const file = join(crate, "src", "a.rs");
    await writeFile(file, "fn a() {}\n");
    const env = { CLAUDE_CONFIG_DIR: c, PATH: `${bin}:${process.env.PATH}` };

    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: file }, cwd: crate, session_id: "rc1", env });
    const result = await runHook("format-on-stop.sh", { tool_name: "", tool_input: {}, cwd: crate, session_id: "rc1", env });

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(bin, "cargo.log"), "utf-8")).rejects.toThrow();
    expect(await readFile(join(bin, "rustfmt.log"), "utf-8")).toContain(file);
    await rm(c, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
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

describe("format-files.sh: no project compiles", () => {
  it("rustfmts a Rust file and does not run cargo", async () => {
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    await makeFakeBin(bin, "cargo");
    await makeFakeBin(bin, "rustfmt");
    const crate = await mkdtemp(join(tmpdir(), "crate-"));
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='x'\n");
    await mkdir(join(crate, "src"), { recursive: true });
    const file = join(crate, "src", "a.rs");
    await writeFile(file, "fn a() {}\n");

    const result = await runNeutralScript("format-files.sh", {
      args: [file],
      cwd: crate,
      env: { PATH: `${bin}:${process.env.PATH}` },
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(bin, "cargo.log"), "utf-8")).rejects.toThrow();
    expect(await readFile(join(bin, "rustfmt.log"), "utf-8")).toContain(file);
    await rm(bin, { recursive: true, force: true });
    await rm(crate, { recursive: true, force: true });
  });

  it("does not run tsc for a TypeScript file", async () => {
    const bin = await mkdtemp(join(tmpdir(), "bin-"));
    await makeFakeBin(bin, "npx");
    const ws = await getHookWorkspace();
    await mkdir(join(ws.dir, "src"), { recursive: true });
    const file = join(ws.dir, "src", "skipped.ts");
    await writeFile(file, "export const n = 1;\n");

    const result = await runNeutralScript("format-files.sh", {
      args: [file],
      cwd: ws.dir,
      env: { PATH: `${bin}:${process.env.PATH}` },
    });

    expect(result.exitCode).toBe(0);
    const log = await readFile(join(bin, "npx.log"), "utf-8").catch(() => "");
    expect(log).not.toContain("tsc");
    expect(log).not.toContain("--noEmit");
    await rm(bin, { recursive: true, force: true });
    await rm(file, { force: true });
  });
});
