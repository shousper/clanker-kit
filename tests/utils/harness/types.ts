export type NormalizedEvent =
  | { kind: "tool_call"; tool: string; input: Record<string, unknown>; id?: string }
  /** The outcome of the tool_call with the same `id`. `text` is the tool's own output (or
   *  the error/hook-block message), never assistant prose. */
  | { kind: "tool_result"; id: string; isError: boolean; text: string }
  | { kind: "text"; text: string }
  | { kind: "fallback"; from: string; to: string }
  | { kind: "error"; message: string };

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  maxTurns?: number;
  pluginDirs?: string[];
  ephemeral?: boolean;
  /** Resume a prior session by id. Session fixtures (tests/fixtures/sessions) are Claude
   *  JSONL only, so this is only wired up on the claude harness; omp ignores it. */
  resume?: string;
  /** With `resume`, continue under a new session id instead of mutating the original. */
  forkSession?: boolean;
  /** Bypass permission prompts so headless runs that write/exec don't hang. */
  dangerouslySkipPermissions?: boolean;
  /** Provider-qualified on omp (see harness/omp.ts); an alias such as `sonnet` on claude. */
  model?: string;
  /** Load only the extensions in `pluginDirs`, not the ones the host harness has installed.
   *  On omp this adds `--no-extensions`; claude runs already use a throwaway config dir with
   *  no installed plugins, so it ignores this. */
  isolateExtensions?: boolean;
}

export interface Harness {
  readonly id: "claude" | "omp";
  readonly bin: string;
  readonly model: string;
  /**
   * Wall-clock budget multiplier relative to Claude Code. Harnesses differ materially in
   * per-turn latency (bigger system prompt, more tools, default thinking level), so a
   * single timeout either kills the slower harness mid-run or wastes the faster one's
   * budget. Measured: omp ~2.2x claude on identical activation cases.
   */
  readonly timeoutScale: number;
  /**
   * The plugin directory THIS harness installs from. Each harness ships its own plugin
   * (plugins/kit-claude vs plugins/kit-omp): the two package real, harness-specific files
   * (e.g. launch-claude.md vs launch-omp.md, omp's package.json#omp.extensions bridge)
   * alongside symlinks into the shared skill/hook/agent content. Pointing a harness at the
   * other one's plugin dir would either silently no-op (Claude Code ignoring omp/) or load
   * files the harness can't use, so this must stay per-harness rather than a single shared
   * constant callers default to.
   */
  readonly pluginRoot: string;
  buildArgs(prompt: string, options: RunOptions): string[];
  parse(stdout: string): NormalizedEvent[];
  /** How this harness reveals that a skill was loaded. */
  skillActivationSignal(events: NormalizedEvent[], skill: string): boolean;
}

export function isToolCall(e: NormalizedEvent, tool: string): boolean {
  return e.kind === "tool_call" && e.tool === tool;
}

export type ToolCallEvent = Extract<NormalizedEvent, { kind: "tool_call" }>;
export type ToolResultEvent = Extract<NormalizedEvent, { kind: "tool_result" }>;

/** Flattens a tool result's `content` (a string, or an array of `{type:"text"}` blocks) to text. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
      const text = String(block.text ?? "");
      if (text.length > 0) parts.push(text);
    }
  }
  return parts.join("\n");
}

/** The result recorded for a call, or undefined when the run ended before one arrived. */
export function resultFor(events: NormalizedEvent[], call: ToolCallEvent): ToolResultEvent | undefined {
  if (call.id === undefined) return undefined;
  return events.find((e): e is ToolResultEvent => e.kind === "tool_result" && e.id === call.id);
}

/** True only when the call produced a result that is not an error. A call with no result
 *  (killed mid-run) or a failed one (bad path, hook block) did not do what it asked. */
export function toolSucceeded(events: NormalizedEvent[], call: ToolCallEvent): boolean {
  const result = resultFor(events, call);
  return result !== undefined && !result.isError;
}
