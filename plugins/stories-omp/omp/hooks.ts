import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { EXIT, hasLegacyMarker, hasMarker } from "../lib/util.mjs";

/**
 * Native OMP hooks for the stories plugin. The story CLI owns every decision
 * (what to inject at session start, which tool calls to deny, whether the
 * loop continues at turn end); these handlers only translate OMP events into
 * CLI calls and CLI results into OMP return values. The CLI is spawned, never
 * imported: the library is synchronous by design (git and gh via spawnSync,
 * lock polling), and a tick can take seconds, which would freeze the UI.
 *
 * Everything starts with a marker check, so a project that never ran
 * stories:setup costs one in-process directory walk per event and nothing
 * else: no spawn, no message, no env stamping.
 *
 * The pure pieces (marker lookup, target selection, env stamping) take no OMP
 * input and are unit-tested without an OMP process; `createHandlers` builds
 * the handlers from injected dependencies; `registerHooks` is the only part
 * that touches `ExtensionAPI`.
 */

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/** Nearest ancestor of `cwd` (inclusive) carrying either marker, or null. A
 *  story worktree carries its own tracked copy, which is fine: the CLI resolves
 *  the main checkout itself; this only answers "is this a stories project". */
export function findStoriesRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (hasMarker(dir) || hasLegacyMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `model:` chain of every `agents/story-planner-*.md`, keyed by agent name.
 *  The frontmatter is the single source of truth for which roles a planner
 *  needs, so the preflight reads it rather than repeating the chains here. */
export function plannerModelChains(pluginRoot: string): Record<string, string[]> {
  const dir = resolve(pluginRoot, "agents");
  const chains: Record<string, string[]> = {};
  for (const file of readdirSync(dir).filter((f) => /^story-planner-.*\.md$/.test(f)).sort()) {
    const text = readFileSync(resolve(dir, file), "utf8");
    const name = /^name:\s*(\S+)/m.exec(text)?.[1];
    const model = /^model:\s*(.+)$/m.exec(text)?.[1] ?? "";
    if (!name) continue;
    chains[name] = [...model.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  return chains;
}

/** Planner agents whose whole chain resolves to no model under the current
 *  settings. `resolve` is `ctx.models.resolve`; anything it cannot map is
 *  reported before a run claims a story and parks it on that error. */
export function unresolvedPlanners(chains: Record<string, string[]>, resolveModel: (spec: string) => unknown): string[] {
  return Object.entries(chains)
    .filter(([, chain]) => !chain.some((spec) => resolveModel(spec) !== undefined))
    .map(([name]) => name);
}

/** OMP tools whose call writes a file. `edit` wire-renames itself to
 *  `apply_patch` in apply_patch mode; both are covered. guard.mjs's
 *  WRITE_TOOLS/ASK_TOOLS hold the authoritative policy — this is only the
 *  OMP-specific tool-name spelling used to decide whether to shell out. */
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, apply_patch: true };

export interface GuardTarget {
  tool: string;
  /** Every file the call touches, absolute; empty for the ask class. */
  paths: string[];
}

/** The runtime derives `path` (one file) or `paths` (a multi-file hashline
 *  batch) from the edit payload before `tool_call` fires; a write carries
 *  `path` itself. Both spellings are read so a batch that touches the board
 *  alongside source is still judged. Relative paths are relative to the
 *  session cwd, which can sit below the stories root; they are made absolute
 *  here so `story guard`, which resolves against the root, judges the file
 *  the tool actually writes. */
export function guardTarget(toolName: string, input: Record<string, unknown> | undefined | null, cwd: string): GuardTarget | null {
  if (WRITE_TOOLS[toolName]) {
    const paths = new Set<string>();
    const add = (p: unknown) => {
      if (typeof p === "string" && p.length > 0) paths.add(isAbsolute(p) ? p : resolve(cwd, p));
    };
    add(input?.path);
    if (Array.isArray(input?.paths)) for (const p of input.paths) add(p);
    return paths.size > 0 ? { tool: toolName, paths: [...paths] } : null;
  }
  if (toolName === "ask") return { tool: "ask", paths: [] };
  return null;
}

// cli.mjs's sessionFromEnv reads this same variable name.
const SESSION_ENV = "STORY_SESSION_ID";

/** The bash call's input with STORY_SESSION_ID added to its structured env, so
 *  `story claim` and `story loop start` typed by the worker bind to this
 *  session without the model passing --session. */
export function stampSessionEnv(input: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const env = (input.env ?? {}) as Record<string, string>;
  return { ...input, env: { ...env, [SESSION_ENV]: sessionId } };
}

// ---------------------------------------------------------------------------
// Handler factory — injected deps make this testable without an OMP runtime
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOpts {
  cwd: string;
  env?: Record<string, string>;
}

export type ExecFn = (command: string, args: string[], opts: ExecOpts) => Promise<ExecResult>;

export interface ExecCall {
  command: string;
  args: string[];
  opts: ExecOpts;
}

export interface StoriesHookDeps {
  /** Spawns the story CLI and returns its stdout/stderr/exit code. */
  exec: ExecFn;
  /** Injects text as model-visible context for the next turn. */
  sendMessage: (text: string) => void;
  /** Surfaces a user-visible notification. */
  notify: (message: string) => void;
}

export interface MinimalHookContext {
  cwd?: string;
  hasUI?: boolean;
  sessionManager?: { getSessionId(): string };
  models?: { resolve(spec: string): unknown };
}

export interface ToolCallLike {
  toolName: string;
  input?: Record<string, unknown>;
}

export type ToolCallResult = { block: true; reason: string } | { input: Record<string, unknown> } | undefined;
export type SessionStopResult = { decision: "block"; reason: string } | undefined;

export interface StoriesHandlers {
  sessionStart(event: unknown, ctx?: MinimalHookContext): Promise<void>;
  sessionCompact(event: unknown, ctx?: MinimalHookContext): Promise<void>;
  toolCall(event: ToolCallLike, ctx?: MinimalHookContext): Promise<ToolCallResult>;
  sessionStop(event: unknown, ctx?: MinimalHookContext): Promise<SessionStopResult>;
}

export function createHandlers(pluginRoot: string, deps: StoriesHookDeps): StoriesHandlers {
  const story = resolve(pluginRoot, "bin/story");
  const rootFor = (ctx?: MinimalHookContext) => findStoriesRoot(ctx?.cwd ?? process.cwd());
  const sessionFor = (ctx?: MinimalHookContext) => ctx?.sessionManager?.getSessionId() ?? "";

  const injectContext = async (ctx: MinimalHookContext | undefined): Promise<void> => {
    const root = rootFor(ctx);
    if (!root) return;
    try {
      const result = await deps.exec(story, ["context"], { cwd: root });
      const text = result.stdout.trim();
      if (result.code === 0 && text) deps.sendMessage(text);
    } catch {
      // Never block a session on a context-injection failure.
    }
  };

  return {
    async sessionStart(_event, ctx) {
      await injectContext(ctx);
      if (!ctx?.models || !rootFor(ctx)) return;
      let missing: string[];
      try {
        missing = unresolvedPlanners(plannerModelChains(pluginRoot), (spec) => ctx.models!.resolve(spec));
      } catch {
        return; // A preflight failure must never block a session.
      }
      if (missing.length === 0) return;
      const summary = `stories: no model resolves for ${missing.join(", ")} — every story of that complexity will park at planning.`;
      deps.notify(`${summary} Populate the built-in plan and slow roles in /model → Roles.`);
      deps.sendMessage(`${summary} Report this to your human partner.`);
    },

    async sessionCompact(_event, ctx) {
      await injectContext(ctx);
    },

    async toolCall(event, ctx) {
      const root = rootFor(ctx);
      if (!root) return undefined;
      const session = sessionFor(ctx);
      if (event.toolName === "bash") {
        return session ? { input: stampSessionEnv(event.input ?? {}, session) } : undefined;
      }
      const target = guardTarget(event.toolName, event.input, ctx?.cwd ?? process.cwd());
      if (!target) return undefined;
      try {
        const opts = { cwd: root, ...(session ? { env: { [SESSION_ENV]: session } } : {}) };
        // The ask class is one guard call with no path; a write is one call per
        // touched file, and the first denial wins.
        const runs = target.paths.length > 0 ? target.paths.map((p) => ["--path", p]) : [[]];
        for (const pathArgs of runs) {
          const result = await deps.exec(story, ["guard", "--tool", target.tool, ...pathArgs, "--json"], opts);
          if (result.code !== EXIT.DENY) continue;
          const verdict = JSON.parse(result.stdout) as { allow: boolean; reason?: string };
          if (verdict.allow === false && verdict.reason) return { block: true, reason: verdict.reason };
        }
        return undefined;
      } catch {
        return undefined; // A broken guard must never lock every edit in the project.
      }
    },

    async sessionStop(_event, ctx) {
      const root = rootFor(ctx);
      if (!root) return undefined;
      const session = sessionFor(ctx);
      if (!session) return undefined;
      try {
        const result = await deps.exec(story, ["loop", "tick", "--session", session, "--json"], { cwd: root });
        if (result.code === EXIT.ERROR) return undefined;
        const tick = JSON.parse(result.stdout) as { decision: string; reason?: string; summary?: string };
        if (tick.decision === "block" && tick.reason) return { decision: "block", reason: tick.reason };
        if (tick.summary) deps.notify(tick.summary);
        return undefined;
      } catch {
        return undefined; // A broken CLI must never wedge stopping.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OMP runtime wiring
// ---------------------------------------------------------------------------

async function execViaBunSpawn(command: string, args: string[], opts: ExecOpts): Promise<ExecResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

export function registerHooks(pi: ExtensionAPI, pluginRoot: string): void {
  const handlersFor = (ctx: ExtensionContext): StoriesHandlers =>
    createHandlers(pluginRoot, {
      exec: execViaBunSpawn,
      sendMessage: (text) => pi.sendMessage(text, { deliverAs: "nextTurn" }),
      notify: (message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "info");
      },
    });

  pi.on("session_start", async (event, ctx) => {
    await handlersFor(ctx).sessionStart(event, ctx);
  });
  // Not in the published event-name union yet; the runtime emits it (design mechanism check 4).
  pi.on("session_compact" as never, async (event: unknown, ctx: ExtensionContext) => {
    await handlersFor(ctx).sessionCompact(event, ctx);
  });
  pi.on("tool_call", async (event, ctx) => handlersFor(ctx).toolCall(event as unknown as ToolCallLike, ctx));
  pi.on("session_stop", async (event, ctx) => handlersFor(ctx).sessionStop(event, ctx));
}
