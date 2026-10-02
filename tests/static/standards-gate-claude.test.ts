import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runHook } from "../utils/hook-workspace";

// The Claude wrappers translate hook JSON into calls on the neutral gate. These tests drive
// the wrappers the way Claude Code does (JSON on stdin) against a fake plugin root holding
// only code-standards/<lang>/CLAUDE.md, with an isolated CLAUDE_CONFIG_DIR for gate state.

interface Fixture {
  root: string;        // fake plugin root (CLAUDE_PLUGIN_ROOT)
  cfg: string;         // CLAUDE_CONFIG_DIR
  proj: string;        // session cwd
  rustStd: string;     // standards path exactly as the gate prints it
  env: Record<string, string>;
}
type Who = { session_id?: string; agent_id?: string };

const MAIN: Who = { session_id: "main-session" };
const SUB: Who = { session_id: "main-session", agent_id: "agent-a" };
const SUB_B: Who = { session_id: "main-session", agent_id: "agent-b" };

const made: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

async function makeFixture(bashFirst: string | undefined): Promise<Fixture> {
  const root = await tmp("kit-plugin-");
  for (const lang of ["rust", "tailwindcss"]) {
    await mkdir(join(root, "code-standards", lang), { recursive: true });
    await writeFile(join(root, "code-standards", lang, "CLAUDE.md"), `# ${lang} standards\n`);
  }
  const cfg = await tmp("kit-cfg-");
  const proj = await tmp("kit-proj-");
  const env: Record<string, string> = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: cfg };
  if (bashFirst) env.PATH = `${bashFirst}:${process.env.PATH}`;
  return { root, cfg, proj, rustStd: join(root, "code-standards/rust/CLAUDE.md"), env };
}

const edit = (f: Fixture, file_path: string, o: { who?: Who; cwd?: string; tool?: string } = {}) =>
  runHook("standards-check.sh", {
    tool_name: o.tool ?? "Edit", tool_input: { file_path }, cwd: o.cwd ?? f.proj, env: f.env, ...(o.who ?? MAIN),
  });

const denial = (stdout: string) => JSON.parse(stdout).hookSpecificOutput;

const read = (f: Fixture, file_path: string, o: { who?: Who; cwd?: string; range?: Record<string, number> } = {}) =>
  runHook("standards-seen.sh", {
    tool_name: "Read", tool_input: { file_path, ...(o.range ?? {}) }, cwd: o.cwd ?? f.proj, env: f.env, ...(o.who ?? MAIN),
  });

// SessionStart carries no tool fields; existing tests pass empty ones (see hcl-detect tests).
const reset = (f: Fixture, who: Who = MAIN) =>
  runHook("standards-reset.sh", { tool_name: "", tool_input: {}, cwd: f.proj, env: f.env, ...who });

// Each mode runs the whole suite; "bash 3.2 gate" puts /bin/bash (3.2 on macOS) ahead of
// bash 5 for the gate's `#!/usr/bin/env bash` shebang. A gate that breaks there fails open
// and silently allows every edit.
const MODES: [string, boolean][] = [["default bash", false], ["gate under /bin/bash", true]];

describe.each(MODES)("Claude standards gate wrappers (%s)", (_mode, useBinBash) => {
  let f: Fixture;
  beforeEach(async () => {
    let bashDir: string | undefined;
    if (useBinBash && existsSync("/bin/bash")) {
      bashDir = await tmp("kit-bash-");
      await symlink("/bin/bash", join(bashDir, "bash"));
    }
    f = await makeFixture(bashDir);
  });
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  describe("standards-check.sh", () => {
    it("denies the first edit in a language with the absolute standards path, then allows the retry", async () => {
      const file = join(f.proj, "src/main.rs");
      const first = await edit(f, file);
      expect(first.exitCode).toBe(0);
      const out = denial(first.stdout);
      expect(out.hookEventName).toBe("PreToolUse");
      expect(out.permissionDecision).toBe("deny");
      expect(out.permissionDecisionReason).toContain(file);
      expect(out.permissionDecisionReason).toContain(f.rustStd);

      const second = await edit(f, file);
      expect(second.exitCode).toBe(0);
      expect(second.stdout.trim()).toBe("");
    });

    it("is silent for files outside any gated language and does not consume the Rust block", async () => {
      const notes = await edit(f, join(f.proj, "notes.md"));
      expect(notes.exitCode).toBe(0);
      expect(notes.stdout.trim()).toBe("");

      const rust = await edit(f, join(f.proj, "lib.rs"), { tool: "Write" });
      expect(denial(rust.stdout).permissionDecision).toBe("deny");
    });

    it("keys state by agent_id: each subagent and the main session are blocked once, independently", async () => {
      const file = join(f.proj, "src/main.rs");
      expect(denial((await edit(f, file, { who: SUB })).stdout).permissionDecision).toBe("deny");
      expect((await edit(f, file, { who: SUB })).stdout.trim()).toBe("");

      // Same session_id, different agent: still unseen.
      expect(denial((await edit(f, file, { who: SUB_B })).stdout).permissionDecision).toBe("deny");
      expect(denial((await edit(f, file, { who: MAIN })).stdout).permissionDecision).toBe("deny");

      expect((await edit(f, file, { who: SUB_B })).stdout.trim()).toBe("");
      expect((await edit(f, file, { who: MAIN })).stdout.trim()).toBe("");
    });

    it("resolves a relative file_path against the hook cwd (Tailwind project signal found from cwd)", async () => {
      await writeFile(join(f.proj, "tailwind.config.js"), "module.exports = {};\n");
      const r = await edit(f, "src/App.tsx");
      expect(r.exitCode).toBe(0);
      const reason = denial(r.stdout).permissionDecisionReason as string;
      expect(reason).toContain(join(f.proj, "src/App.tsx"));
      expect(reason).toContain(join(f.root, "code-standards/tailwindcss/CLAUDE.md"));
    });
  });

  describe("standards-seen.sh", () => {
    it("a full read of the standards file stops the block, silently", async () => {
      const r = await read(f, f.rustStd);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");

      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(e.exitCode).toBe(0);
      expect(e.stdout.trim()).toBe("");
    });

    it.each([
      ["limit", { limit: 50 }],
      ["offset", { offset: 10 }],
      ["offset and limit", { offset: 1, limit: 50 }],
    ])("a ranged read (%s) does not count as loading the standards", async (_label, range) => {
      await read(f, f.rustStd, { range });
      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(denial(e.stdout).permissionDecision).toBe("deny");
    });

    it("a read of an unrelated CLAUDE.md does not count", async () => {
      const other = join(f.proj, "CLAUDE.md");
      await writeFile(other, "# project notes\n");
      await read(f, other);
      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(denial(e.stdout).permissionDecision).toBe("deny");
    });

    it("resolves a relative file_path against the hook cwd", async () => {
      await read(f, "code-standards/rust/CLAUDE.md", { cwd: f.root });
      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(e.stdout.trim()).toBe("");
    });

    it("a read by one subagent does not unlock another agent", async () => {
      await read(f, f.rustStd, { who: SUB });
      expect((await edit(f, join(f.proj, "a.rs"), { who: SUB })).stdout.trim()).toBe("");
      expect(denial((await edit(f, join(f.proj, "a.rs"), { who: MAIN })).stdout).permissionDecision).toBe("deny");
    });
  });

  describe("standards-reset.sh", () => {
    it("compaction returns a prompted language to unseen, so the next edit is blocked again", async () => {
      const file = join(f.proj, "src/main.rs");
      expect(denial((await edit(f, file)).stdout).permissionDecision).toBe("deny");
      expect((await edit(f, file)).stdout.trim()).toBe("");

      const r = await reset(f);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");

      expect(denial((await edit(f, file)).stdout).permissionDecision).toBe("deny");
    });

    it("compaction also invalidates a loaded language: the standards text left context", async () => {
      await read(f, f.rustStd);
      expect((await edit(f, join(f.proj, "a.rs"))).stdout.trim()).toBe("");

      await reset(f);
      expect(denial((await edit(f, join(f.proj, "a.rs"))).stdout).permissionDecision).toBe("deny");
    });

    it("resetting the main session leaves subagent state alone", async () => {
      const file = join(f.proj, "a.rs");
      await edit(f, file, { who: SUB });
      await reset(f, MAIN);
      expect((await edit(f, file, { who: SUB })).stdout.trim()).toBe("");
    });

    it("exits 0 silently when no state exists", async () => {
      const r = await reset(f);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });
  });
});
