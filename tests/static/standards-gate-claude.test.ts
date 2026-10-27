import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runHook } from "../utils/hook-workspace";
import { KIT_CLAUDE_HOOKS_DIR } from "../utils/paths";

// The Claude wrappers translate hook JSON into calls on the neutral gate. These tests drive
// the wrappers the way Claude Code does (JSON on stdin) against a fake plugin root holding
// only code-standards/scope.md and code-standards/<lang>/core.md, with an isolated CLAUDE_CONFIG_DIR for gate state.

interface Fixture {
  root: string;        // fake plugin root (CLAUDE_PLUGIN_ROOT)
  cfg: string;         // CLAUDE_CONFIG_DIR
  proj: string;        // session cwd
  scopeStd: string;    // scope standards path exactly as the gate prints it
  rustStd: string;     // Rust core standards path exactly as the gate prints it
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

/** Reads the scope and Rust core standards in full, the units a first .rs edit needs. */
async function readBoth(f: Fixture, o: { who?: Who; range?: Record<string, number> } = {}) {
  await read(f, f.scopeStd, o);
  return read(f, f.rustStd, o);
}

async function makeFixture(bashFirst: string | undefined, prefix = "kit-"): Promise<Fixture> {
  const root = await tmp(`${prefix}plugin-`);
  await mkdir(join(root, "code-standards"), { recursive: true });
  await writeFile(join(root, "code-standards", "scope.md"), "# scope\n");
  for (const lang of ["go", "rust", "hcl", "python", "cpp", "tailwindcss"]) {
    await mkdir(join(root, "code-standards", lang), { recursive: true });
    await writeFile(join(root, "code-standards", lang, "core.md"), `# ${lang} standards\n`);
  }
  const cfg = await tmp("kit-cfg-");
  const proj = await tmp(`${prefix}proj-`);
  const env: Record<string, string> = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: cfg };
  if (bashFirst) env.PATH = `${bashFirst}:${process.env.PATH}`;
  return { root, cfg, proj, scopeStd: join(root, "code-standards/scope.md"), rustStd: join(root, "code-standards/rust/core.md"), env };
}

/** Runs a wrapper with raw stdin, for payloads runHook cannot express (malformed JSON). */
async function runRaw(script: string, stdin: string, env: Record<string, string>) {
  const proc = Bun.spawn([join(KIT_CLAUDE_HOOKS_DIR, script)], {
    stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
}

/** Runs the neutral gate directly, bypassing the wrapper's prefilter. */
async function gateCheck(f: Fixture, file: string) {
  const proc = Bun.spawn([join(KIT_CLAUDE_HOOKS_DIR, "shared/standards-gate.sh"), "check", file], {
    stdout: "pipe", stderr: "ignore",
    env: {
      ...process.env, ...f.env, KIT_PLUGIN_ROOT: f.root,
      KIT_STATE_DIR: join(f.cfg, "kit/state"), KIT_SCRATCH_KEY: "gate-direct",
    },
  });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
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
      expect(out.permissionDecisionReason).toContain(f.scopeStd);
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
      expect(reason).toContain(join(f.root, "code-standards/tailwindcss/core.md"));
    });

    it("handles a path with spaces and a tab, absolute and relative", async () => {
      const sp = await makeFixture(undefined, "kit sp\tace ");
      const abs = join(sp.proj, "my src/main.go");
      const first = await edit(sp, abs);
      expect(denial(first.stdout).permissionDecisionReason).toContain(abs);
      expect((await edit(sp, abs)).stdout.trim()).toBe("");

      const rel = await edit(sp, "my src/lib.rs");
      expect(denial(rel.stdout).permissionDecisionReason).toContain(join(sp.proj, "my src/lib.rs"));
    });

    it("exits 0 silently on malformed JSON", async () => {
      const r = await runRaw("standards-check.sh", "{not json main.go", f.env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    // The wrapper skips the gate for names that cannot be gated. That list is hand-kept
    // in step with the gate's file table, so each pattern family needs a representative
    // the wrapper lets through to a gate that maps it to units.
    describe("wrapper file-name prefilter stays in sync with the gate", () => {
      const GATED = [
        "main.go", "go.mod", "go.sum",
        "lib.rs", "Cargo.toml", "clippy.toml", "rust-toolchain.toml",
        "main.tf", "main.tofu", "main.tofu.json", "vars.tfvars",
        "app.py", "stubs.pyi", "pyproject.toml",
        "a.cpp", "a.cc", "a.cxx", "a.hpp", "a.hh", "a.hxx", "a.ipp", "a.tpp", "a.inl", "a.h",
        "CMakeLists.txt", "tools.cmake", "CMakePresets.json", ".clang-tidy", ".clang-format",
        "app.css", "App.tsx", "App.jsx", "App.vue", "App.svelte", "App.astro", "index.html",
      ];
      const UNGATED = ["README.md", "foo.ts", "Makefile", "notes.txt"];
      const signals = async () => {
        await writeFile(join(f.proj, "tailwind.config.js"), "module.exports = {};\n");
        await writeFile(join(f.proj, "main.cpp"), "int main() {}\n");
      };

      it.each(GATED)("%s is mapped to units by the gate and blocked through the wrapper", async (name) => {
        await signals();
        const file = join(f.proj, name);
        expect((await gateCheck(f, file)).exitCode).toBe(2);
        const r = await edit(f, file);
        expect(r.exitCode).toBe(0);
        expect(denial(r.stdout).permissionDecision).toBe("deny");
      });

      it.each(UNGATED)("%s is allowed by both the wrapper and the gate", async (name) => {
        await signals();
        const file = join(f.proj, name);
        const direct = await gateCheck(f, file);
        expect(direct.exitCode).toBe(0);
        expect(direct.stdout.trim()).toBe("");
        const viaWrapper = await edit(f, file);
        expect(viaWrapper.exitCode).toBe(0);
        expect(viaWrapper.stdout.trim()).toBe("");
      });
    });
  });

  describe("standards-seen.sh", () => {
    it("a full read of the scope and core standards stops the block, silently", async () => {
      const r = await readBoth(f);
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
      await readBoth(f, { range });
      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(denial(e.stdout).permissionDecision).toBe("deny");
    });

    it("a read of an unrelated core.md does not count", async () => {
      const other = join(f.proj, "core.md");
      await writeFile(other, "# project notes\n");
      await read(f, other);
      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(denial(e.stdout).permissionDecision).toBe("deny");
    });

    it("resolves a relative file_path against the hook cwd", async () => {
      await read(f, "code-standards/scope.md", { cwd: f.root });
      await read(f, "code-standards/rust/core.md", { cwd: f.root });
      const e = await edit(f, join(f.proj, "src/main.rs"));
      expect(e.stdout.trim()).toBe("");
    });

    it("a read by one subagent does not unlock another agent", async () => {
      await readBoth(f, { who: SUB });
      expect((await edit(f, join(f.proj, "a.rs"), { who: SUB })).stdout.trim()).toBe("");
      expect(denial((await edit(f, join(f.proj, "a.rs"), { who: MAIN })).stdout).permissionDecision).toBe("deny");
    });

    it("a standards file read under a plugin root with spaces and a tab still unlocks the edit", async () => {
      const sp = await makeFixture(undefined, "kit sp\tace ");
      await read(sp, sp.scopeStd);
      await read(sp, join(sp.root, "code-standards/go/core.md"));
      const e = await edit(sp, join(sp.proj, "main.go"));
      expect(e.exitCode).toBe(0);
      expect(e.stdout.trim()).toBe("");
    });

    it("a read payload carrying a very large tool_response is still recognised", async () => {
      const payload = (file_path: string) => JSON.stringify({
        session_id: "main-session", cwd: f.proj, tool_name: "Read", tool_input: { file_path },
        tool_response: { file: { content: "x".repeat(200_000) } },
      });
      expect((await runRaw("standards-seen.sh", payload(f.scopeStd), f.env)).exitCode).toBe(0);
      expect((await runRaw("standards-seen.sh", payload(join(f.root, "code-standards/go/core.md")), f.env)).exitCode).toBe(0);
      expect((await edit(f, join(f.proj, "main.go"))).stdout.trim()).toBe("");
    });

    it("exits 0 silently on malformed JSON", async () => {
      const r = await runRaw("standards-seen.sh", 'not json scope.md"', f.env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
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
      await readBoth(f);
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
