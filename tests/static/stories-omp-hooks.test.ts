import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createHandlers, findStoriesRoot, guardTarget, plannerModelChains, stampSessionEnv, unresolvedPlanners, type ExecCall } from "../../plugins/stories-omp/omp/hooks";
import { STORIES_OMP_ROOT } from "../utils/paths";

const PLUGIN_ROOT = "/plugin-root";
const STORY = resolve(PLUGIN_ROOT, "bin/story");

const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(marker: "new" | "legacy" | "none" = "new"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stories-omp-")));
  projects.push(dir);
  if (marker === "new") {
    mkdirSync(join(dir, ".agents", "shousper-stories"), { recursive: true });
    writeFileSync(join(dir, ".agents", "shousper-stories", "config.json"), "{}");
  } else if (marker === "legacy") {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "story-workflow.json"), "{}");
  }
  mkdirSync(join(dir, ".worktrees", "st-a1b2", "src"), { recursive: true });
  return dir;
}

describe("findStoriesRoot", () => {
  it("walks up from a nested cwd (including a story worktree) to either marker, or returns null", () => {
    const root = project();
    expect(findStoriesRoot(root)).toBe(root);
    expect(findStoriesRoot(join(root, ".worktrees", "st-a1b2", "src"))).toBe(root);
    const legacy = project("legacy");
    expect(findStoriesRoot(legacy)).toBe(legacy);
    expect(findStoriesRoot(project("none"))).toBeNull();
  });
});

describe("planner model preflight", () => {
  it("reads every planner's chain from its frontmatter and reports only agents with no resolvable entry", () => {
    const chains = plannerModelChains(STORIES_OMP_ROOT);
    expect(Object.keys(chains).sort()).toEqual(["story-planner-frontier", "story-planner-hard", "story-planner-routine"]);
    for (const chain of Object.values(chains)) expect(chain.length).toBeGreaterThan(0);
    const only = (ok: string[]) => (spec: string) => (ok.includes(spec) ? { id: spec } : undefined);
    expect(unresolvedPlanners(chains, only(["@plan", "@slow", "@default"]))).toEqual([]);
    expect(unresolvedPlanners(chains, only(["@plan", "@default"]))).toEqual(["story-planner-frontier"]);
    expect(unresolvedPlanners(chains, only(["@default"]))).toEqual(["story-planner-frontier", "story-planner-hard"]);
    expect(unresolvedPlanners(chains, () => undefined)).toEqual(Object.keys(chains).sort());
  });

  it("session_start names unresolvable planners to the user and the model, and stays quiet when all resolve", async () => {
    const dir = project();
    const make = (ok: string[]) => {
      const messages: string[] = [];
      const notes: string[] = [];
      const handlers = createHandlers(STORIES_OMP_ROOT, {
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        sendMessage: (t) => { messages.push(t); },
        notify: (t) => { notes.push(t); },
      });
      const models = { resolve: (spec: string) => (ok.includes(spec) ? { id: spec } : undefined) };
      return { handlers, messages, notes, models };
    };
    const bad = make(["@default"]);
    await bad.handlers.sessionStart({}, { ...ctx(dir), models: bad.models });
    expect(bad.notes).toHaveLength(1);
    expect(bad.messages).toHaveLength(1);
    expect(bad.messages[0]).toContain("story-planner-hard");
    expect(bad.messages[0]).toContain("Report this to your human partner");
    expect(bad.notes[0]).toContain("story-planner-hard");
    expect(bad.notes[0]).toContain("story-planner-frontier");
    expect(bad.notes[0]).not.toContain("story-planner-routine");
    expect(bad.notes[0]).toContain("/model → Roles");
    const good = make(["@plan", "@slow"]);
    await good.handlers.sessionStart({}, { ...ctx(dir), models: good.models });
    expect(good.notes).toEqual([]);
    expect(good.messages).toEqual([]);
  });
});

describe("guardTarget", () => {
  it("collects path and paths for write/edit/apply_patch, a bare target for ask, and null otherwise", () => {
    expect(guardTarget("write", { path: "/p/stories/a.md" }, "/p")).toEqual({ tool: "write", paths: ["/p/stories/a.md"] });
    expect(guardTarget("apply_patch", { path: "/p/a.md" }, "/p")).toEqual({ tool: "apply_patch", paths: ["/p/a.md"] });
    expect(guardTarget("edit", { input: "[src/x.ts#1A2B]\n...", paths: ["src/x.ts", "stories/st-a1b2.md"] }, "/p")).toEqual({ tool: "edit", paths: ["/p/src/x.ts", "/p/stories/st-a1b2.md"] });
    expect(guardTarget("edit", { path: "src/x.ts", paths: ["src/x.ts"] }, "/p")).toEqual({ tool: "edit", paths: ["/p/src/x.ts"] });
    expect(guardTarget("edit", { content: "x" }, "/p")).toBeNull();
    expect(guardTarget("ask", { questions: [] }, "/p")).toEqual({ tool: "ask", paths: [] });
    expect(guardTarget("read", { path: "/p/a.md" }, "/p")).toBeNull();
  });

  it("resolves a relative path against the session cwd, so a cwd below the root still names the board file", () => {
    expect(guardTarget("write", { path: "../stories/st-a1b2.md" }, "/p/src")).toEqual({ tool: "write", paths: ["/p/stories/st-a1b2.md"] });
  });
});

describe("stampSessionEnv", () => {
  it("adds STORY_SESSION_ID to the call's env without dropping existing entries", () => {
    expect(stampSessionEnv({ command: "story claim st-1", env: { FOO: "1" } }, "sess-1")).toEqual({
      command: "story claim st-1",
      env: { FOO: "1", STORY_SESSION_ID: "sess-1" },
    });
  });
});

function harness(responses: Record<string, { stdout: string; code: number }>) {
  const calls: ExecCall[] = [];
  const messages: string[] = [];
  const notes: string[] = [];
  const handlers = createHandlers(PLUGIN_ROOT, {
    exec: async (command, args, opts) => {
      calls.push({ command, args, opts });
      const r = responses[args.slice(0, 2).join(" ")] ?? { stdout: "", code: 0 };
      return { stdout: r.stdout, stderr: "", code: r.code };
    },
    sendMessage: (text) => { messages.push(text); },
    notify: (text) => { notes.push(text); },
  });
  return { calls, messages, notes, handlers };
}

const ctx = (cwd: string, session = "sess-1") => ({ cwd, sessionManager: { getSessionId: () => session } });

describe("createHandlers", () => {
  it("is inert without a marker: no spawn, no message, no block, no env stamp", async () => {
    const dir = project("none");
    const h = harness({});
    await h.handlers.sessionStart({}, ctx(dir));
    expect(await h.handlers.toolCall({ toolName: "bash", input: { command: "ls" } }, ctx(dir))).toBeUndefined();
    expect(await h.handlers.toolCall({ toolName: "write", input: { path: "stories/x.md" } }, ctx(dir))).toBeUndefined();
    expect(await h.handlers.sessionStop({}, ctx(dir))).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(h.messages).toEqual([]);
  });

  it("still injects context on the legacy layout so the migration notice reaches the session", async () => {
    const dir = project("legacy");
    const h = harness({ "context": { stdout: "RULES + run story doctor\n", code: 0 } });
    await h.handlers.sessionStart({}, ctx(dir));
    expect(h.calls.map((c) => [c.command, c.args, c.opts.cwd])).toEqual([[STORY, ["context"], dir]]);
    expect(h.messages).toEqual(["RULES + run story doctor"]);
  });

  it("session_start sends `story context` output for the next turn; session_compact re-sends it the same way", async () => {
    const dir = project();
    const h = harness({ "context": { stdout: "RULES BLOCK\n", code: 0 } });
    await h.handlers.sessionStart({}, ctx(dir));
    await h.handlers.sessionCompact({}, ctx(dir));
    expect(h.calls.map((c) => [c.command, c.args, c.opts.cwd])).toEqual([[STORY, ["context"], dir], [STORY, ["context"], dir]]);
    expect(h.messages).toEqual(["RULES BLOCK", "RULES BLOCK"]);
  });

  it("tool_call stamps STORY_SESSION_ID into bash calls", async () => {
    const dir = project();
    const h = harness({});
    const r = await h.handlers.toolCall({ toolName: "bash", input: { command: "story claim st-a1b2" } }, ctx(dir, "worker-1"));
    expect(r).toEqual({ input: { command: "story claim st-a1b2", env: { STORY_SESSION_ID: "worker-1" } } });
    expect(h.calls).toEqual([]);
  });

  it("tool_call blocks a denied write with the CLI's reason and passes the session to the ask rule", async () => {
    const dir = project();
    const h = harness({ "guard --tool": { stdout: JSON.stringify({ allow: false, reason: "use story update" }), code: 2 } });
    const r = await h.handlers.toolCall({ toolName: "write", input: { path: join(dir, "stories/st-a1b2.md") } }, ctx(dir, "worker-1"));
    expect(r).toEqual({ block: true, reason: "use story update" });
    expect(h.calls[0]).toEqual({ command: STORY, args: ["guard", "--tool", "write", "--path", join(dir, "stories/st-a1b2.md"), "--json"], opts: { cwd: dir, env: { STORY_SESSION_ID: "worker-1" } } });
    await h.handlers.toolCall({ toolName: "ask", input: { questions: [] } }, ctx(dir, "worker-1"));
    expect(h.calls[1].args).toEqual(["guard", "--tool", "ask", "--json"]);
  });

  it("tool_call judges every path of a multi-file edit batch and blocks on the first denial", async () => {
    const dir = project();
    const calls: string[][] = [];
    const handlers = createHandlers(PLUGIN_ROOT, {
      exec: async (_command, args) => {
        calls.push(args);
        const denied = args.includes(join(dir, "stories/st-a1b2.md"));
        return denied
          ? { stdout: JSON.stringify({ allow: false, reason: "use story update" }), stderr: "", code: 2 }
          : { stdout: JSON.stringify({ allow: true }), stderr: "", code: 0 };
      },
      sendMessage: () => {},
      notify: () => {},
    });
    const r = await handlers.toolCall({ toolName: "edit", input: { input: "...", paths: ["src/x.ts", "stories/st-a1b2.md", "src/y.ts"] } }, ctx(dir));
    expect(r).toEqual({ block: true, reason: "use story update" });
    expect(calls).toEqual([
      ["guard", "--tool", "edit", "--path", join(dir, "src/x.ts"), "--json"],
      ["guard", "--tool", "edit", "--path", join(dir, "stories/st-a1b2.md"), "--json"],
    ]);
  });

  it("tool_call lets allowed and failing guard calls through", async () => {
    const dir = project();
    const allow = harness({ "guard --tool": { stdout: JSON.stringify({ allow: true }), code: 0 } });
    expect(await allow.handlers.toolCall({ toolName: "edit", input: { path: "src/x.ts" } }, ctx(dir))).toBeUndefined();
    const broken = harness({ "guard --tool": { stdout: "", code: 1 } });
    expect(await broken.handlers.toolCall({ toolName: "edit", input: { path: "stories/x.md" } }, ctx(dir))).toBeUndefined();
  });

  it("session_stop returns the tick's block decision, notifies an allow summary, and swallows failures", async () => {
    const dir = project();
    const block = harness({ "loop tick": { stdout: JSON.stringify({ decision: "block", reason: "Work st-a1b2", status: "story st-a1b2 · iteration 1 · stalls 0/3" }), code: 2 } });
    expect(await block.handlers.sessionStop({}, ctx(dir, "worker-1"))).toEqual({ decision: "block", reason: "Work st-a1b2" });
    expect(block.calls[0]).toEqual({ command: STORY, args: ["loop", "tick", "--session", "worker-1", "--json"], opts: { cwd: dir } });
    const allow = harness({ "loop tick": { stdout: JSON.stringify({ decision: "allow", summary: "Story loop finished." }), code: 0 } });
    expect(await allow.handlers.sessionStop({}, ctx(dir))).toBeUndefined();
    expect(allow.notes).toEqual(["Story loop finished."]);
    const quiet = harness({ "loop tick": { stdout: JSON.stringify({ decision: "allow" }), code: 0 } });
    expect(await quiet.handlers.sessionStop({}, ctx(dir))).toBeUndefined();
    expect(quiet.notes).toEqual([]);
    const broken = harness({ "loop tick": { stdout: "not json", code: 1 } });
    expect(await broken.handlers.sessionStop({}, ctx(dir))).toBeUndefined();
  });
});
