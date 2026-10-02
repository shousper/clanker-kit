import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Native OMP hook handlers. Replaces the deleted cross-harness protocol
 * bridge with `pi.on(...)` handlers that spawn the same neutral
 * `shared/hooks` scripts the sibling plugin's own hook wrappers call — no
 * stdin/JSON/exit-code translation protocol travels through this file or
 * the scripts it spawns. The extension process is persistent for the life
 * of the session, so edited-file tracking is an in-memory Set rather than
 * the scratch files cross-process hook wrappers need.
 *
 * The pure pieces below (path extraction, command construction, state-dir
 * resolution) take no OMP-shaped input and are unit-tested without an OMP
 * process. `createHandlers` builds the four testable handlers from injected
 * dependencies; `registerHooks` is the only part that touches `ExtensionAPI`.
 *
 * Paths arrive relative to the session's working directory, which is not the
 * OMP process's cwd when the session runs in a worktree or after `/move`.
 * Every edited path is resolved against `ctx.cwd` when recorded, and the
 * formatter runs with that cwd, so its existence checks and the eslint/tsc
 * project boundary see the session's checkout.
 */

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

const STATE_DIR_ENV = "KIT_STATE_DIR";

/** Directory the shared scripts persist non-LLM state under. OMP has no
 *  preexisting per-user config-dir convention of its own, so this always
 *  computes an explicit value and hands it to spawned scripts via
 *  KIT_STATE_DIR — the one env var `shared/hooks/lib.sh` trusts outright,
 *  ahead of its own sibling-harness config-dir/HOME fallback chain. */
export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
  return env[STATE_DIR_ENV] || resolve(homedir(), ".omp", "kit", "state");
}

/** OMP tool names whose successful result means a file changed on disk.
 *  `edit` wire-renames itself to `apply_patch` in apply_patch mode; both
 *  names are tracked here so either mode is covered. */
const EDITED_FILE_TOOLS: Record<string, true> = { write: true, edit: true, apply_patch: true };

/** The files a write/edit/apply_patch tool touched, resolved against `cwd`.
 *  The runtime derives `path` (one file) or `paths` (a multi-file hashline
 *  batch) from the edit payload; a write carries `path` itself. Empty when
 *  the tool isn't one that edits a file or the event carries no usable path.
 *  Callers are responsible for skipping error results — this only looks at
 *  the shape of `input`. */
export function collectEditedPaths(toolName: string, input: Record<string, unknown> | undefined | null, cwd: string): string[] {
  if (!EDITED_FILE_TOOLS[toolName]) return [];
  const raw: unknown[] = [];
  if (typeof input?.path === "string") raw.push(input.path);
  if (Array.isArray(input?.paths)) raw.push(...input.paths);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0) continue;
    const path = isAbsolute(p) ? p : resolve(cwd, p);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** Builds the argv (script path followed by args) for the shared formatter
 *  script: the edited files, as positional arguments. */
export function buildFormatCommand(pluginRoot: string, files: readonly string[]): string[] {
  return [resolve(pluginRoot, "hooks/format-files.sh"), ...files];
}

/** A full read of a standards file: bare `CLAUDE.md` basename, optionally with
 *  the `:raw` read selector. Line-range selectors are partial reads and do
 *  not count. */
const STANDARDS_FILE_PATH = /(^|\/)CLAUDE\.md(:raw)?$/;

const STALE_STATE_MS = 2 * 24 * 60 * 60 * 1000;

/** Removes `standards-*.txt` gate state older than two days. Mirrors
 *  `find -mtime +1`, which compares whole 24-hour periods. */
function pruneStaleStandards(stateDir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(stateDir)) {
      if (!/^standards-.*\.txt$/.test(name)) continue;
      const file = resolve(stateDir, name);
      try {
        if (statSync(file).mtimeMs <= now - STALE_STATE_MS) unlinkSync(file);
      } catch {
        // A concurrent cleanup or malformed state entry must not stall a session.
      }
    }
  } catch {
    // A missing or inaccessible state directory is harmless.
  }
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

export interface HookHandlerDeps {
  /** Runs a shared script and returns its stdout/stderr/exit code. */
  exec: ExecFn;
  /** Injects text as model-visible context on the next turn. */
  sendMessage: (text: string) => void;
  /** Surfaces a user-visible notification. Callers only invoke this when a
   *  UI actually exists for the firing session. */
  notify: (message: string) => void;
}

/** The slice of `ExtensionContext` these handlers read. Kept minimal and
 *  structural (not imported from the runtime package) so tests can pass a
 *  plain object instead of standing up a real OMP session. */
export interface MinimalHookContext {
  cwd?: string;
  hasUI?: boolean;
  sessionManager?: { getSessionId(): string };
}

export interface ToolResultLike {
  toolName: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolCallLike {
  toolName: string;
  input?: Record<string, unknown>;
}

export type ToolCallResult = { block: true; reason: string } | undefined;

export interface HookHandlers {
  sessionStart(event: unknown, ctx?: MinimalHookContext): Promise<void>;
  toolCall(event: ToolCallLike, ctx?: MinimalHookContext): Promise<ToolCallResult>;
  toolResult(event: ToolResultLike, ctx?: MinimalHookContext): Promise<void>;
  sessionCompact(event: unknown, ctx?: MinimalHookContext): Promise<void>;
  sessionStop(event: unknown, ctx?: MinimalHookContext): Promise<void>;
  agentEnd(event: unknown, ctx?: MinimalHookContext): Promise<void>;
}

/**
 * Builds the four `pi.on(...)` handlers, backed by an in-memory Set of
 * edited files per session. `editedFilesBySession` may be shared across
 * repeated calls (the real wiring rebuilds deps per event to bind the
 * firing `ctx`, but state must survive that) — it defaults to a private Map
 * when a caller (e.g. a test) has no reason to share one.
 */
export function createHandlers(
  pluginRoot: string,
  deps: HookHandlerDeps,
  editedFilesBySession: Map<string, Set<string>> = new Map(),
): HookHandlers {
  const filesFor = (sessionKey: string): Set<string> => {
    let files = editedFilesBySession.get(sessionKey);
    if (!files) {
      files = new Set();
      editedFilesBySession.set(sessionKey, files);
    }
    return files;
  };

  const flushFormat = async (sessionKey: string, cwd: string): Promise<void> => {
    const files = editedFilesBySession.get(sessionKey);
    if (!files || files.size === 0) return;
    const toFormat = [...files];
    files.clear();
    try {
      const [command, ...args] = buildFormatCommand(pluginRoot, toFormat);
      const result = await deps.exec(command, args, { cwd });
      const summary = result.stdout.trim();
      if (summary) deps.notify(summary);
    } catch {
      // A formatting failure must never affect the session.
    }
  };

  const cwdFor = (ctx?: MinimalHookContext) => ctx?.cwd ?? process.cwd();
  const sessionKeyFor = (ctx?: MinimalHookContext) => ctx?.sessionManager?.getSessionId() ?? "default";
  const gateScript = resolve(pluginRoot, "hooks/standards-gate.sh");
  const runGate = (args: string[], ctx?: MinimalHookContext): Promise<ExecResult> =>
    deps.exec(gateScript, args, {
      cwd: cwdFor(ctx),
      env: { KIT_SCRATCH_KEY: sessionKeyFor(ctx) },
    });
  const markStandardsRead = async (event: ToolResultLike, ctx?: MinimalHookContext): Promise<void> => {
    const path = event.input?.path;
    if (event.toolName !== "read" || typeof path !== "string" || !STANDARDS_FILE_PATH.test(path)) return;
    try {
      await runGate(["seen", isAbsolute(path) ? path : resolve(cwdFor(ctx), path)], ctx);
    } catch {
      // Failing to record a read only means the gate asks once more.
    }
  };

  return {
    async sessionStart(_event, ctx) {
      try {
        const cwd = cwdFor(ctx);
        const scriptPath = resolve(pluginRoot, "hooks/session-context.sh");
        const result = await deps.exec(scriptPath, [], { cwd });
        const context = result.stdout.trim();
        if (context) deps.sendMessage(context);
      } catch {
        // Never block session start on a context-injection failure.
      }
    },

    async toolCall(event, ctx) {
      try {
        for (const path of collectEditedPaths(event.toolName, event.input, cwdFor(ctx))) {
          const result = await runGate(["check", path], ctx);
          if (result.code === 2) return { block: true, reason: result.stdout.trim() };
        }
      } catch {
        // A gate failure must never stall an edit.
      }
      return undefined;
    },

    async toolResult(event, ctx) {
      if (event.isError) return;
      await markStandardsRead(event, ctx);
      const paths = collectEditedPaths(event.toolName, event.input, cwdFor(ctx));
      if (paths.length === 0) return;
      const files = filesFor(sessionKeyFor(ctx));
      for (const path of paths) files.add(path);
    },

    async sessionCompact(_event, ctx) {
      try {
        await runGate(["reset"], ctx);
      } catch {
        // A gate failure must never stall the session.
      }
    },

    async sessionStop(_event, ctx) {
      await flushFormat(sessionKeyFor(ctx), cwdFor(ctx));
    },

    async agentEnd(_event, ctx) {
      await flushFormat(sessionKeyFor(ctx), cwdFor(ctx));
    },
  };
}

// ---------------------------------------------------------------------------
// OMP runtime wiring
// ---------------------------------------------------------------------------

/** Spawns a shared script with the session cwd and the kit env vars the
 *  scripts read (KIT_PLUGIN_ROOT/KIT_STATE_DIR). Bun's spawn is used directly,
 *  as the sibling plugins do, because `ExtensionAPI.exec` exposes neither an
 *  `env` nor a `cwd` option. */
function buildExec(env: Record<string, string>): ExecFn {
  return async (command, args, opts) => {
    const proc = Bun.spawn([command, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...env, ...(opts.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
}

/**
 * Registers the native OMP handlers that replace the old cross-harness
 * protocol bridge. Reaches `shared/hooks` scripts through this plugin's
 * `hooks/` symlink (kept in place so the sibling plugin's own protocol
 * wrappers consume the same logic — this is the single deliberate seam
 * between the two plugins).
 */
export function registerHooks(pi: ExtensionAPI, pluginRoot: string): void {
  const editedFilesBySession = new Map<string, Set<string>>();
  const scriptEnv = { KIT_PLUGIN_ROOT: pluginRoot, KIT_STATE_DIR: resolveStateDir(process.env) };

  const handlersFor = (ctx: ExtensionContext): HookHandlers =>
    createHandlers(
      pluginRoot,
      {
        exec: buildExec(scriptEnv),
        sendMessage: (text) => pi.sendMessage(text, { deliverAs: "nextTurn" }),
        notify: (message) => {
          if (ctx.hasUI) ctx.ui.notify(message, "info");
        },
      },
      editedFilesBySession,
    );

  pi.on("session_start", async (event, ctx) => {
    pruneStaleStandards(scriptEnv.KIT_STATE_DIR);
    await handlersFor(ctx).sessionStart(event, ctx);
  });
  pi.on("tool_call", async (event, ctx) => handlersFor(ctx).toolCall(event as unknown as ToolCallLike, ctx));
  pi.on("tool_result", async (event, ctx) => {
    await handlersFor(ctx).toolResult(event, ctx);
  });
  pi.on("session_compact" as never, async (event: unknown, ctx: ExtensionContext) => {
    await handlersFor(ctx).sessionCompact(event, ctx);
  });
  pi.on("session_stop", async (event, ctx) => {
    await handlersFor(ctx).sessionStop(event, ctx);
  });
  pi.on("agent_end", async (event, ctx) => {
    await handlersFor(ctx).agentEnd(event, ctx);
  });
}
