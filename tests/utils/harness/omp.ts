import { contentText, toolSucceeded, type Harness, type NormalizedEvent, type RunOptions } from "./types";
import { KIT_OMP_ROOT } from "../paths";

/** Exact, provider-qualified id. `--model sonnet` fuzzy-matches the dead claude-sonnet-4-0
 *  and silently falls back to another provider, which invalidates the run. A bare
 *  `claude-sonnet-5` is ambiguous the moment another provider exposes claude-named
 *  models, so the provider prefix is required here too. */
const MODEL = process.env.OMP_EVAL_MODEL || "anthropic/claude-sonnet-5";

function parseLines(stdout: string): unknown[] {
  return stdout.split("\n").flatMap((line) => {
    const t = line.trim();
    if (!t.startsWith("{")) return [];
    try { return [JSON.parse(t)]; } catch { return []; }
  });
}

export const omp: Harness = {
  id: "omp",
  bin: process.env.OMP_BIN || "omp",
  model: MODEL,
  // Measured on identical activation cases: omp ~2.2x claude (larger system prompt, more
  // tools, and `auto` thinking resolving to `medium`). Unscaled, trials died at exit 124
  // mid-run and were misread as activation failures.
  timeoutScale: 2.5,
  pluginRoot: KIT_OMP_ROOT,

  buildArgs(prompt, options) {
    const args = ["-p", "--mode", "json", "--model", options.model ?? MODEL];
    // `-e` (not `--plugin-dir`): verified that `--plugin-dir` loads skills and agents but
    // NOT `package.json#omp.extensions`, so the hook bridge never runs and session-start.sh
    // never injects the using-kit governance block. Evaluating with `--plugin-dir` would
    // measure a configuration we don't ship and under-report activation.
    for (const dir of options.pluginDirs ?? []) args.push("-e", dir);
    // An installed kit-omp (for example one linked to another checkout) registers its own
    // gate next to the `-e` copy, so an agent sees two gates with different standards
    // files. `--no-extensions` stops discovery; explicit `-e` paths still load.
    if (options.isolateExtensions) args.push("--no-extensions");
    // Skills come from the plugin OMP has installed, not from the `-e` directory. While the
    // linked install still points at a checkout that has the retired code-standards skill,
    // agents load it, chase its unreachable `../..` table, and time out before editing.
    // Excluding it models the shipped plugin; the flag is a no-op once no install has it.
    args.push("--skills", "!code-standards");
    // OMP has no --max-turns; bound wall-clock instead. Scaled so omp self-terminates at
    // the same budget the runner enforces, rather than being killed during startup.
    if (options.timeout) {
      args.push("--max-time", String(Math.ceil((options.timeout * 2.5) / 1000)));
    }
    if (options.ephemeral) args.push("--no-session");
    if (options.dangerouslySkipPermissions) args.push("--approval-mode", "yolo");
    // resume/forkSession are intentionally unwired: session fixtures (tests/fixtures/sessions)
    // are Claude JSONL, a format omp's session store doesn't read, so there's nothing to resume.
    args.push(prompt);
    return args;
  },

  parse(stdout) {
    const out: NormalizedEvent[] = [];
    const seen = new Set<string>();
    const seenResults = new Set<string>();
    const pushResult = (message: { toolCallId?: unknown; isError?: unknown; content?: unknown } | undefined) => {
      const id = typeof message?.toolCallId === "string" ? message.toolCallId : "";
      if (!id || seenResults.has(id)) return;
      seenResults.add(id);
      out.push({ kind: "tool_result", id, isError: message?.isError === true, text: contentText(message?.content) });
    };
    for (const ev of parseLines(stdout) as any[]) {
      if (ev.type === "retry_fallback_applied") {
        out.push({ kind: "fallback", from: String(ev.from), to: String(ev.to) });
        continue;
      }
      if (ev.type === "extension_error") {
        out.push({ kind: "error", message: String(ev.error ?? `extension error in ${ev.extensionPath ?? "unknown"}`) });
        continue;
      }
      if (ev.type !== "message_end" && ev.type !== "turn_end") continue;
      // Only the assistant's own blocks are calls and prose. A toolResult message is tool
      // output: record it as a result keyed by the call it answers, never as `text`. The
      // user's prompt is not the assistant speaking either.
      if (ev.message?.role === "toolResult") {
        pushResult(ev.message);
        continue;
      }
      if (ev.message?.role === "user") continue;
      for (const b of ev.message?.content ?? []) {
        if (b.type === "toolCall") {
          if (b.id && seen.has(b.id)) continue;
          if (b.id) seen.add(b.id);
          out.push({ kind: "tool_call", tool: b.name, input: b.arguments ?? {}, id: b.id });
        } else if (b.type === "text") {
          out.push({ kind: "text", text: b.text ?? "" });
        }
      }
      // turn_end repeats the turn's results; it is the only copy if message_end was missed.
      if (ev.type === "turn_end") for (const r of ev.toolResults ?? []) pushResult(r);
    }
    return out;
  },

  skillActivationSignal(events, skill) {
    const bare = skill.includes(":") ? skill.split(":")[1] : skill;
    // A failed read (`skill://x/../../y` collapses to a missing path) is not an activation.
    return events.some(
      (e) => e.kind === "tool_call" && e.tool === "read" &&
        String(e.input.path ?? "").replace(/^skill:\/\//, "").split("/")[0] === bare &&
        toolSucceeded(events, e),
    );
  },
};
