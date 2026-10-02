import { contentText, toolSucceeded, type Harness, type NormalizedEvent, type RunOptions } from "./types";
import { KIT_CLAUDE_ROOT } from "../paths";

/** Claude Code's own alias resolution is reliable; only OMP's fuzzy match is not. */
const MODEL = "sonnet";

interface ClaudeContentBlock {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface ClaudeAssistantEvent {
  type: "assistant";
  message?: { content?: ClaudeContentBlock[] };
}

interface ClaudeUserEvent {
  type: "user";
  message?: { content?: ClaudeContentBlock[] | string };
}

interface ClaudeResultEvent {
  type: "result";
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

function isAssistantEvent(value: unknown): value is ClaudeAssistantEvent {
  return typeof value === "object" && value !== null && "type" in value && value.type === "assistant";
}

function isUserEvent(value: unknown): value is ClaudeUserEvent {
  return typeof value === "object" && value !== null && "type" in value && value.type === "user";
}

function isResultEvent(value: unknown): value is ClaudeResultEvent {
  return typeof value === "object" && value !== null && "type" in value && value.type === "result";
}

export const claude: Harness = {
  id: "claude",
  bin: process.env.CLAUDE_BIN || "claude",
  model: MODEL,
  timeoutScale: 1,
  pluginRoot: KIT_CLAUDE_ROOT,

  buildArgs(prompt, options) {
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--model", options.model ?? MODEL];
    for (const dir of options.pluginDirs ?? []) args.push("--plugin-dir", dir);
    if (options.maxTurns !== undefined) args.push("--max-turns", String(options.maxTurns));
    if (options.ephemeral) args.push("--no-session-persistence");
    if (options.resume) args.push("--resume", options.resume);
    if (options.forkSession) args.push("--fork-session");
    if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    args.push(prompt);
    return args;
  },

  parse(stdout) {
    const out: NormalizedEvent[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isResultEvent(parsed) && parsed.is_error) {
        out.push({ kind: "error", message: parsed.result || `claude run failed (${parsed.subtype ?? "unknown"})` });
        continue;
      }
      if (isUserEvent(parsed)) {
        // Tool outcomes arrive as user-role events. Their text blocks (synthetic skill
        // bodies, reminders) are not assistant prose and are not emitted as `text`.
        const blocks = parsed.message?.content;
        for (const block of Array.isArray(blocks) ? blocks : []) {
          if (block.type === "tool_result" && block.tool_use_id) {
            out.push({ kind: "tool_result", id: block.tool_use_id, isError: block.is_error === true, text: contentText(block.content) });
          }
        }
        continue;
      }
      if (!isAssistantEvent(parsed)) continue;
      for (const block of parsed.message?.content ?? []) {
        if (block.type === "tool_use" && block.name) {
          out.push({ kind: "tool_call", tool: block.name, input: block.input ?? {}, id: block.id });
        } else if (block.type === "text") {
          out.push({ kind: "text", text: block.text ?? "" });
        }
      }
    }
    return out;
  },

  skillActivationSignal(events, skill) {
    const bare = skill.includes(":") ? skill.split(":")[1] : skill;
    return events.some((e) => {
      if (e.kind !== "tool_call" || e.tool !== "Skill") return false;
      const used = String(e.input.skill ?? "").trim();
      // An unknown skill returns an error result and loads nothing.
      return (used === skill || used === bare || used.split(":").pop() === bare) && toolSucceeded(events, e);
    });
  },
};
