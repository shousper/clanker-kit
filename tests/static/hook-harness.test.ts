import { describe, it, expect, afterAll } from "bun:test";
import { join } from "path";
import { readdirSync } from "fs";
import {
  getHclWorkspace,
  cleanupHookWorkspace,
  runHook,
  runNeutralScript,
} from "../utils/hook-workspace";
import { ROOT, HOOKS_DIR, SKILLS_DIR } from "../utils/paths";

afterAll(async () => {
  await cleanupHookWorkspace();
});

// --- session-start ---

describe("session-start.sh", () => {
  it("outputs hookSpecificOutput JSON with using-kit content", async () => {
    const result = await runHook("session-start.sh", {
      tool_name: "",
      tool_input: {},
      cwd: ROOT,
    });

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.hookSpecificOutput).toBeDefined();
    expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(json.hookSpecificOutput.additionalContext).toContain("EXTREMELY_IMPORTANT");
    expect(json.hookSpecificOutput.additionalContext).toContain("kit");
  });
});

// --- hook-workspace env support ---

describe("hook-workspace env support", () => {
  it("runHook forwards a custom env to the script", async () => {
    const ws = await getHclWorkspace();
    const result = await runHook("hcl-tool.sh", {
      tool_name: "",
      tool_input: {},
      cwd: ws.dir,
      args: ["root", ws.dir],
      env: { KIT_SENTINEL: "ok" },
      dir: HOOKS_DIR,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(ws.dir);
  });
});

// --- hook-workspace agent_id support ---

describe("hook-workspace agent_id support", () => {
  it("runHook includes agent_id in the hook JSON when provided", async () => {
    const ws = await getHclWorkspace();
    // record.sh keys the scratch by agent_id when present; prove the field arrives.
    const cfg = await import("fs/promises").then(fs => import("os").then(os => fs.mkdtemp(join(os.tmpdir(), "kit-cfg-"))));
    const { readFile } = await import("fs/promises");
    await runHook("record.sh", {
      tool_name: "Edit", tool_input: { file_path: join(ws.dir, "main.tf") }, cwd: ws.dir,
      session_id: "sess-x", agent_id: "agent-y", env: { CLAUDE_CONFIG_DIR: cfg },
    });
    // Keyed by agent_id, NOT session_id:
    await expect(readFile(join(cfg, "kit/state/touched-agent-y.txt"), "utf-8")).resolves.toContain("main.tf");
    await expect(readFile(join(cfg, "kit/state/touched-sess-x.txt"), "utf-8")).rejects.toThrow();
  });
});

// --- hcl-detect ---

describe("hcl-detect.sh", () => {
  it("is silent for a non-HCL project", async () => {
    const dir = await import("fs/promises").then(fs => import("os").then(os => fs.mkdtemp(join(os.tmpdir(),"nohcl-"))));
    const cfg = await import("fs/promises").then(fs => import("os").then(os => fs.mkdtemp(join(os.tmpdir(),"kit-cfg-"))));
    const r = await runHook("hcl-detect.sh", { tool_name:"", tool_input:{}, cwd: dir, env: { CLAUDE_CONFIG_DIR: cfg } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("emits a systemMessage for an undetected HCL project, then is silent", async () => {
    const ws = await getHclWorkspace();
    const cfg = await import("fs/promises").then(fs => import("os").then(os => fs.mkdtemp(join(os.tmpdir(),"kit-cfg-"))));
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const first = await runHook("hcl-detect.sh", { tool_name:"", tool_input:{}, cwd: ws.dir, env });
    const j1 = first.stdout.trim() ? JSON.parse(first.stdout) : null;
    expect(j1?.systemMessage ?? "").toContain("/kit:hcl-tool");
    const second = await runHook("hcl-detect.sh", { tool_name:"", tool_input:{}, cwd: ws.dir, env });
    expect(second.stdout.trim()).toBe("");
  });

  it("hcl-detect prunes scratch and standards-gate state older than a day and keeps fresh ones", async () => {
    const cfg = await import("fs/promises").then(fs => import("os").then(os => fs.mkdtemp(join(os.tmpdir(),"kit-cfg-"))));
    const { mkdir, writeFile, utimes, stat } = await import("fs/promises");
    const stateDir = join(cfg, "kit/state");
    await mkdir(stateDir, { recursive: true });
    const stale = ["touched-dead.txt", "standards-dead.txt"].map((n) => join(stateDir, n));
    const fresh = ["touched-live.txt", "standards-live.txt"].map((n) => join(stateDir, n));
    for (const p of [...stale, ...fresh]) await writeFile(p, "/x/main.tf\n");
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
    for (const p of stale) await utimes(p, twoDaysAgo, twoDaysAgo);
    // cwd need not be HCL; prune runs regardless before the early-exits.
    const nonHcl = await import("fs/promises").then(fs => import("os").then(os => fs.mkdtemp(join(os.tmpdir(),"nohcl-"))));
    await runHook("hcl-detect.sh", { tool_name:"", tool_input:{}, cwd: nonHcl, env: { CLAUDE_CONFIG_DIR: cfg } });
    for (const p of stale) await expect(stat(p)).rejects.toThrow();   // pruned
    for (const p of fresh) await expect(stat(p)).resolves.toBeDefined(); // kept
  });
});

// --- session-context.sh (neutral: args/env in, plain text out, no JSON) ---

describe("session-context.sh", () => {
  it("prints the using-kit governance body, frontmatter stripped, no JSON anywhere", async () => {
    const r = await runNeutralScript("session-context.sh", { env: { KIT_PLUGIN_ROOT: ROOT } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("EXTREMELY_IMPORTANT");
    expect(r.stdout).not.toContain("hookSpecificOutput");
    expect(r.stdout).not.toContain("{\n");
    expect(r.stdout.split("\n")[0]).not.toBe("---"); // frontmatter stripped
  });

  it("names only kit skills that ship, so agents never copy an 'Unknown skill'", async () => {
    const r = await runNeutralScript("session-context.sh", { env: { KIT_PLUGIN_ROOT: ROOT } });
    expect(r.exitCode).toBe(0);
    const shipped = new Set(readdirSync(SKILLS_DIR));
    const named = [...r.stdout.matchAll(/\bkit:([a-z0-9-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(shipped.has(name), `session context names kit:${name}`).toBe(true);
  });

  it("fails loudly without KIT_PLUGIN_ROOT (no silent wrong-path read)", async () => {
    const r = await runNeutralScript("session-context.sh");
    expect(r.exitCode).not.toBe(0);
  });
});
