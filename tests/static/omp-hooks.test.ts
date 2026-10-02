import { afterEach, describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { CODE_STANDARDS_DIR, HOOKS_DIR } from "../utils/paths";
import { collectEditedPaths, buildFormatCommand, resolveStateDir, createHandlers, registerHooks, type ExecOpts, type ExecResult, type HookHandlerDeps } from "../../plugins/kit-omp/omp/hooks";

const PLUGIN_ROOT = "/plugin-root";
const CWD = "/work";

describe("collectEditedPaths", () => {
  it("returns the path for a write tool result", () => {
    expect(collectEditedPaths("write", { path: "/proj/a.go" }, CWD)).toEqual(["/proj/a.go"]);
  });

  it("returns the path for an edit tool result", () => {
    expect(collectEditedPaths("edit", { path: "/proj/b.rs" }, CWD)).toEqual(["/proj/b.rs"]);
  });

  it("returns the path for an apply_patch tool result (edit's wire name in apply_patch mode)", () => {
    expect(collectEditedPaths("apply_patch", { path: "/proj/c.ts" }, CWD)).toEqual(["/proj/c.ts"]);
  });

  it("resolves a relative path against the session cwd, not the process cwd", () => {
    expect(collectEditedPaths("write", { path: "src/a.go" }, "/repo/.worktrees/st-1")).toEqual(["/repo/.worktrees/st-1/src/a.go"]);
  });

  it("reads every file of a multi-file hashline batch, deduplicated", () => {
    expect(collectEditedPaths("edit", { paths: ["a.go", "/abs/b.rs", "a.go"] }, CWD)).toEqual(["/work/a.go", "/abs/b.rs"]);
  });

  it("ignores reads — read is not a file-editing tool", () => {
    expect(collectEditedPaths("read", { path: "/proj/a.go" }, CWD)).toEqual([]);
  });

  it("ignores unrelated tools (bash, grep, custom tools)", () => {
    expect(collectEditedPaths("bash", { command: "ls" }, CWD)).toEqual([]);
    expect(collectEditedPaths("grep", { pattern: "foo" }, CWD)).toEqual([]);
    expect(collectEditedPaths("my_custom_tool", { path: "/proj/a.go" }, CWD)).toEqual([]);
  });

  it("returns nothing when input carries no path field", () => {
    expect(collectEditedPaths("write", { content: "x" }, CWD)).toEqual([]);
  });

  it("returns nothing when input is undefined or null", () => {
    expect(collectEditedPaths("write", undefined, CWD)).toEqual([]);
    expect(collectEditedPaths("write", null, CWD)).toEqual([]);
  });

  it("skips path entries that are not non-empty strings", () => {
    expect(collectEditedPaths("write", { path: "" }, CWD)).toEqual([]);
    expect(collectEditedPaths("write", { path: 42 as unknown as string }, CWD)).toEqual([]);
    expect(collectEditedPaths("edit", { paths: ["", 7, "/abs/ok.ts"] }, CWD)).toEqual(["/abs/ok.ts"]);
  });
});

describe("buildFormatCommand", () => {
  it("resolves the shared format-files.sh script under hooks/, followed by the file args", () => {
    const command = buildFormatCommand(PLUGIN_ROOT, ["/proj/a.go", "/proj/b.rs"]);
    expect(command).toEqual([resolve(PLUGIN_ROOT, "hooks/format-files.sh"), "/proj/a.go", "/proj/b.rs"]);
  });

  it("produces just the script path when there are no files", () => {
    expect(buildFormatCommand(PLUGIN_ROOT, [])).toEqual([resolve(PLUGIN_ROOT, "hooks/format-files.sh")]);
  });
});

describe("resolveStateDir", () => {
  it("uses KIT_STATE_DIR when set", () => {
    expect(resolveStateDir({ KIT_STATE_DIR: "/tmp/kit-state" })).toBe("/tmp/kit-state");
  });

  it("falls back to ~/.omp/kit/state when KIT_STATE_DIR is unset", () => {
    expect(resolveStateDir({})).toBe(resolve(homedir(), ".omp", "kit", "state"));
  });

  it("ignores an empty-string KIT_STATE_DIR and falls back", () => {
    expect(resolveStateDir({ KIT_STATE_DIR: "" })).toBe(resolve(homedir(), ".omp", "kit", "state"));
  });
});

// --- createHandlers: injected-deps behavior, no OMP runtime required -------

function fakeDeps(execImpl?: (command: string, args: string[]) => Promise<ExecResult>): HookHandlerDeps & {
  sentMessages: string[];
  notifications: string[];
  execCalls: { command: string; args: string[]; opts: ExecOpts }[];
} {
  const sentMessages: string[] = [];
  const notifications: string[] = [];
  const execCalls: { command: string; args: string[]; opts: ExecOpts }[] = [];
  return {
    sentMessages,
    notifications,
    execCalls,
    exec: async (command, args, opts) => {
      execCalls.push({ command, args, opts });
      if (execImpl) return execImpl(command, args);
      return { stdout: "", stderr: "", code: 0 };
    },
    sendMessage: (text) => sentMessages.push(text),
    notify: (message) => notifications.push(message),
  };
}

const formatCall = (cwd: string, ...files: string[]) => ({ command: resolve(PLUGIN_ROOT, "hooks/format-files.sh"), args: files, opts: { cwd } });

const ctxFor = (sessionId: string, cwd = "/work") => ({ cwd, hasUI: true, sessionManager: { getSessionId: () => sessionId } });

describe("createHandlers: sessionStart", () => {
  it("sends the session-context script's stdout as next-turn context", async () => {
    const deps = fakeDeps(async () => ({ stdout: "  governance block  \n", stderr: "", code: 0 }));
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.sessionStart({}, ctxFor("S1"));

    expect(deps.sentMessages).toEqual(["governance block"]);
    expect(deps.execCalls).toEqual([{ command: resolve(PLUGIN_ROOT, "hooks/session-context.sh"), args: [], opts: { cwd: "/work" } }]);
  });

  it("sends nothing when the script prints only whitespace", async () => {
    const deps = fakeDeps(async () => ({ stdout: "   \n", stderr: "", code: 0 }));
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.sessionStart({}, ctxFor("S1"));

    expect(deps.sentMessages).toEqual([]);
  });

  it("falls back to process.cwd() when ctx carries no cwd", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.sessionStart({});

    expect(deps.execCalls[0]?.opts).toEqual({ cwd: process.cwd() });
  });

  it("swallows a throwing exec instead of propagating", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("spawn failed");
    });
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await expect(handlers.sessionStart({}, ctxFor("S1"))).resolves.toBeUndefined();
    expect(deps.sentMessages).toEqual([]);
  });
});

describe("createHandlers: toolResult", () => {
  it("tracks an edited file from a successful write result", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([formatCall("/work", "/proj/a.go")]);
  });

  it("ignores a read tool result", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "read", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([]);
  });

  it("ignores an errored write result", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: true }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([]);
  });

  it("keeps separate sessions' edited files isolated", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.toolResult({ toolName: "write", input: { path: "/proj/b.go" }, isError: false }, ctxFor("S2"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([formatCall("/work", "/proj/a.go")]);
  });

  it("deduplicates repeated edits of the same file within a session", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.toolResult({ toolName: "edit", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([formatCall("/work", "/proj/a.go")]);
  });

  it("records a relative path against the session cwd and formats in that cwd", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);
    const worktree = "/repo/.worktrees/st-1";

    await handlers.toolResult({ toolName: "edit", input: { path: "src/a.go" }, isError: false }, ctxFor("S1", worktree));
    await handlers.sessionStop({}, ctxFor("S1", worktree));

    expect(deps.execCalls).toEqual([formatCall(worktree, `${worktree}/src/a.go`)]);
  });

  it("tracks every file of a multi-file hashline batch", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "edit", input: { paths: ["a.go", "b.rs"] }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([formatCall("/work", "/work/a.go", "/work/b.rs")]);
  });
});

describe("createHandlers: sessionStop clears the Set", () => {
  it("does not re-format the same files on a second stop with no new edits", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toHaveLength(1);
  });

  it("does nothing when nothing was edited", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([]);
  });

  it("surfaces the formatter's stdout summary via notify", async () => {
    const deps = fakeDeps(async () => ({ stdout: "formatted 1 file\n", stderr: "", code: 0 }));
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.notifications).toEqual(["formatted 1 file"]);
  });

  it("never notifies when the formatter prints nothing", async () => {
    const deps = fakeDeps(async () => ({ stdout: "", stderr: "", code: 0 }));
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.notifications).toEqual([]);
  });

  it("swallows a throwing exec, still clearing the Set, without propagating", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("format-files.sh crashed");
    });
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await expect(handlers.sessionStop({}, ctxFor("S1"))).resolves.toBeUndefined();
    expect(deps.notifications).toEqual([]);

    // The Set was cleared despite the throw: a second stop makes no further exec call.
    deps.execCalls.length = 0;
    await handlers.sessionStop({}, ctxFor("S1"));
    expect(deps.execCalls).toEqual([]);
  });
});

describe("createHandlers: agentEnd", () => {
  it("flushes the same way sessionStop does", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "apply_patch", input: { path: "/proj/a.py" }, isError: false }, ctxFor("S1"));
    await handlers.agentEnd({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([formatCall("/work", "/proj/a.py")]);
  });

  it("clears the Set so a later sessionStop finds nothing left", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);

    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.agentEnd({}, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toHaveLength(1);
  });
});

describe("createHandlers: shared state across repeated calls", () => {
  it("persists edited files across separate createHandlers(...) calls given the same Map", async () => {
    const deps = fakeDeps();
    const shared = new Map<string, Set<string>>();

    await createHandlers(PLUGIN_ROOT, deps, shared).toolResult(
      { toolName: "write", input: { path: "/proj/a.go" }, isError: false },
      ctxFor("S1"),
    );
    await createHandlers(PLUGIN_ROOT, deps, shared).sessionStop({}, ctxFor("S1"));

    expect(deps.execCalls).toEqual([formatCall("/work", "/proj/a.go")]);
  });
});

const GATE = resolve(PLUGIN_ROOT, "hooks/standards-gate.sh");
const gateCall = (cwd: string, key: string, ...args: string[]) => ({
  command: GATE,
  args,
  opts: { cwd, env: { KIT_SCRATCH_KEY: key } },
});
const REASON = "kit: read Rust standards";

describe("createHandlers: toolCall (standards gate)", () => {
  it("blocks exit 2 with trimmed reason and the session scratch key", async () => {
    const deps = fakeDeps(async () => ({ stdout: `  ${REASON}\n`, stderr: "", code: 2 }));
    const handlers = createHandlers(PLUGIN_ROOT, deps);
    expect(await handlers.toolCall({ toolName: "edit", input: { path: "/proj/a.rs" } }, ctxFor("child")))
      .toEqual({ block: true, reason: REASON });
    expect(deps.execCalls).toEqual([gateCall("/work", "child", "check", "/proj/a.rs")]);
  });

  it("allows exit 0 and a thrown exec", async () => {
    expect(await createHandlers(PLUGIN_ROOT, fakeDeps()).toolCall(
      { toolName: "write", input: { path: "/proj/a.rs" } }, ctxFor("S1"),
    )).toBeUndefined();
    const broken = createHandlers(PLUGIN_ROOT, fakeDeps(async () => { throw new Error("spawn failed"); }));
    await expect(broken.toolCall({ toolName: "edit", input: { path: "/proj/a.rs" } }, ctxFor("S1")))
      .resolves.toBeUndefined();
  });

  it("checks a multi-path batch in order and stops at the first blocked path", async () => {
    const deps = fakeDeps(async (_command, args) => args[1] === "/work/b.rs"
      ? { stdout: REASON, stderr: "", code: 2 }
      : { stdout: "", stderr: "", code: 0 });
    const result = await createHandlers(PLUGIN_ROOT, deps).toolCall(
      { toolName: "edit", input: { paths: ["a.go", "b.rs", "c.tf"] } }, ctxFor("S1"),
    );
    expect(result).toEqual({ block: true, reason: REASON });
    expect(deps.execCalls.map((call) => call.args)).toEqual([
      ["check", "/work/a.go"], ["check", "/work/b.rs"],
    ]);
  });

  it("uses default only without a session manager and skips non-editing tools", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);
    await handlers.toolCall({ toolName: "write", input: { path: "src/a.rs" } });
    await handlers.toolCall({ toolName: "read", input: { path: "/proj/a.rs" } }, ctxFor("S1"));
    expect(deps.execCalls).toEqual([gateCall(process.cwd(), "default", "check", resolve(process.cwd(), "src/a.rs"))]);
  });
});

describe("createHandlers: standards reads and compaction", () => {
  it.each([
    ["/standards/rust/CLAUDE.md", "/standards/rust/CLAUDE.md"],
    ["CLAUDE.md", "/work/CLAUDE.md"],
    ["CLAUDE.md:raw", "/work/CLAUDE.md:raw"],
  ])("marks a full standards read for %s", async (path, expected) => {
    const deps = fakeDeps();
    await createHandlers(PLUGIN_ROOT, deps).toolResult(
      { toolName: "read", input: { path }, isError: false }, ctxFor("S1"),
    );
    expect(deps.execCalls).toEqual([gateCall("/work", "S1", "seen", expected)]);
  });

  it.each(["CLAUDE.md:1-40", "notes/CLAUDE.md.bak", "README.md"])
  ("does not mark partial or unrelated reads: %s", async (path) => {
    const deps = fakeDeps();
    await createHandlers(PLUGIN_ROOT, deps).toolResult(
      { toolName: "read", input: { path }, isError: false }, ctxFor("S1"),
    );
    expect(deps.execCalls).toEqual([]);
  });

  it("does not mark errored or non-read results, and swallows seen failure", async () => {
    const deps = fakeDeps(async () => { throw new Error("seen failed"); });
    const handlers = createHandlers(PLUGIN_ROOT, deps);
    await expect(handlers.toolResult({ toolName: "read", input: { path: "CLAUDE.md" }, isError: false }, ctxFor("S1")))
      .resolves.toBeUndefined();
    const callsAfterFailure = deps.execCalls.length;
    await handlers.toolResult({ toolName: "read", input: { path: "CLAUDE.md" }, isError: true }, ctxFor("S1"));
    await handlers.toolResult({ toolName: "grep", input: { path: "CLAUDE.md" }, isError: false }, ctxFor("S1"));
    expect(deps.execCalls).toHaveLength(callsAfterFailure);
  });

  it("resets gate state on compaction without changing formatter tracking", async () => {
    const deps = fakeDeps();
    const handlers = createHandlers(PLUGIN_ROOT, deps);
    await handlers.toolResult({ toolName: "write", input: { path: "/proj/a.go" }, isError: false }, ctxFor("S1"));
    await handlers.sessionCompact({}, ctxFor("S1"));
    await handlers.sessionStop({}, ctxFor("S1"));
    expect(deps.execCalls).toEqual([
      gateCall("/work", "S1", "reset"),
      formatCall("/work", "/proj/a.go"),
    ]);
  });
});

const temporaryRoots: string[] = [];
afterEach(() => temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function gateProject(): { pluginRoot: string; cwd: string; state: string; standards: string } {
  const pluginRoot = realpathSync(mkdtempSync(join(tmpdir(), "kit-omp-gate-")));
  temporaryRoots.push(pluginRoot);
  const cwd = join(pluginRoot, "project");
  const state = join(pluginRoot, "state");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(state);
  symlinkSync(HOOKS_DIR, join(pluginRoot, "hooks"));
  symlinkSync(CODE_STANDARDS_DIR, join(pluginRoot, "code-standards"));
  writeFileSync(join(cwd, "main.rs"), "fn main() {}\n");
  return { pluginRoot, cwd, state, standards: join(pluginRoot, "code-standards", "rust", "CLAUDE.md") };
}

function registerWithState(project: { pluginRoot: string; state: string }) {
  const registered = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => Promise<unknown>) { registered.set(name, handler); },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  registerHooks(pi, project.pluginRoot);
  return registered;
}

describe("registerHooks: standards gate integration", () => {
  it("blocks once, records a full read, and re-arms on compaction using real Bun.spawn", async () => {
    const project = gateProject();
    const original = process.env.KIT_STATE_DIR;
    process.env.KIT_STATE_DIR = project.state;
    try {
      const registered = registerWithState(project);
      const ctx = { cwd: project.cwd, hasUI: false, sessionManager: { getSessionId: () => "subagent" } };
      const toolCall = registered.get("tool_call");
      const toolResult = registered.get("tool_result");
      const compact = registered.get("session_compact");
      expect(toolCall).toBeDefined();
      expect(toolResult).toBeDefined();
      expect(compact).toBeDefined();

      expect(await toolCall!({ toolName: "edit", input: { path: "main.rs" } }, ctx)).toEqual({
        block: true,
        reason: expect.stringContaining("code-standards/rust/CLAUDE.md"),
      });
      expect(await toolCall!({ toolName: "edit", input: { path: "main.rs" } }, ctx)).toBeUndefined();
      await toolResult!({ toolName: "read", input: { path: project.standards }, isError: false }, ctx);
      expect(await toolCall!({ toolName: "edit", input: { path: "main.rs" } }, ctx)).toBeUndefined();
      await compact!({}, ctx);
      expect(await toolCall!({ toolName: "edit", input: { path: "main.rs" } }, ctx)).toEqual({
        block: true,
        reason: expect.stringContaining("code-standards/rust/CLAUDE.md"),
      });
    } finally {
      if (original === undefined) delete process.env.KIT_STATE_DIR;
      else process.env.KIT_STATE_DIR = original;
    }
  });

  it("removes only standards state older than one day when the session starts", async () => {
    const project = gateProject();
    const old = join(project.state, "standards-old.txt");
    const fresh = join(project.state, "standards-fresh.txt");
    const unrelated = join(project.state, "touched-old.txt");
    writeFileSync(old, "rust loaded\n");
    writeFileSync(fresh, "rust prompted\n");
    writeFileSync(unrelated, "src/main.rs\n");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    utimesSync(unrelated, twoDaysAgo, twoDaysAgo);

    const previous = process.env.KIT_STATE_DIR;
    process.env.KIT_STATE_DIR = project.state;
    try {
      const registered = registerWithState(project);
      const ctx = { cwd: project.cwd, hasUI: false, sessionManager: { getSessionId: () => "S1" } };
      await registered.get("session_start")!({}, ctx);
      expect(existsSync(old)).toBeFalse();
      expect(existsSync(fresh)).toBeTrue();
      expect(existsSync(unrelated)).toBeTrue();
    } finally {
      if (previous === undefined) delete process.env.KIT_STATE_DIR;
      else process.env.KIT_STATE_DIR = previous;
    }
  });
});
