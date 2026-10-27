import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, accessSync, constants } from "fs";
import { resolve } from "path";
import { HOOKS_DIR, KIT_CLAUDE_HOOKS_DIR } from "../utils/paths";

// Source: Claude Code hook system — update these when Claude Code adds new events/tools
// See: https://docs.anthropic.com/en/docs/claude-code/hooks
const VALID_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "Stop", "SubagentStop"];
const VALID_TOOL_MATCHERS = [
  "Write", "Edit", "MultiEdit", "Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch",
  "Task", "Skill", "NotebookEdit", "TodoWrite",
];
const VALID_SESSION_EVENTS = ["startup", "resume", "clear", "compact"];
const SHELLCHECK = Bun.which("shellcheck") ?? "shellcheck";

// hooks.json (Claude schema) lives in the kit-claude plugin now — shared/hooks/
// holds only the neutral, harness-agnostic scripts it delegates to.
const hooksPath = resolve(KIT_CLAUDE_HOOKS_DIR, "hooks.json");
const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
const pluginRoot = resolve(KIT_CLAUDE_HOOKS_DIR, "..");

describe("hooks.json", () => {
  it("is valid JSON with a hooks object", () => {
    expect(hooksConfig).toHaveProperty("hooks");
    expect(typeof hooksConfig.hooks).toBe("object");
    expect(hooksConfig.hooks).not.toBeNull();
  });

  it("all event names are valid Claude Code events", () => {
    for (const event of Object.keys(hooksConfig.hooks)) {
      expect(VALID_EVENTS).toContain(event);
    }
  });

  it("all hook entries have matcher (string) and hooks (array)", () => {
    for (const [event, entries] of Object.entries(hooksConfig.hooks)) {
      expect(Array.isArray(entries)).toBe(true);
      for (const entry of entries as any[]) {
        expect(typeof entry.matcher).toBe("string");
        expect(Array.isArray(entry.hooks)).toBe(true);
      }
    }
  });

  it("PreToolUse and PostToolUse matchers reference valid tool names", () => {
    for (const event of ["PreToolUse", "PostToolUse"]) {
      for (const entry of hooksConfig.hooks[event] ?? []) {
        for (const tool of entry.matcher.split("|")) {
          expect(VALID_TOOL_MATCHERS, `${event} matcher "${entry.matcher}"`).toContain(tool);
        }
      }
    }
  });

  it("all referenced scripts exist on disk", () => {
    for (const entries of Object.values(hooksConfig.hooks)) {
      for (const entry of entries as any[]) {
        for (const hook of entry.hooks) {
          const scriptPath = hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
          expect(() => accessSync(scriptPath)).not.toThrow();
        }
      }
    }
  });

  it("all referenced scripts are executable", () => {
    for (const entries of Object.values(hooksConfig.hooks)) {
      for (const entry of entries as any[]) {
        for (const hook of entry.hooks) {
          const scriptPath = hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
          expect(() => accessSync(scriptPath, constants.X_OK)).not.toThrow();
        }
      }
    }
  });

  it.skipIf(!Bun.which("shellcheck"))("all .sh files in kit-claude hooks/ and shared/hooks/ pass shellcheck", async () => {
    const dirs = [KIT_CLAUDE_HOOKS_DIR, HOOKS_DIR];
    const scripts = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".sh")).map((f) => resolve(d, f)));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const proc = Bun.spawn([SHELLCHECK, "-s", "bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stdout = await new Response(proc.stdout).text();
        throw new Error(`shellcheck failed for ${script}:\n${stdout}`);
      }
    }
  });

  it("SessionStart matchers only reference valid session events", () => {
    const sessionStart = hooksConfig.hooks.SessionStart ?? [];
    for (const entry of sessionStart) {
      for (const part of entry.matcher.split("|")) {
        expect(VALID_SESSION_EVENTS).toContain(part);
      }
    }
  });

  it("registers the unified pipeline and no retired scripts", () => {
    const cmds = (e: string) => (hooksConfig.hooks[e] ?? []).flatMap((x: any) => x.hooks.map((h: any) => h.command));
    expect(cmds("PostToolUse").some((c: string) => c.endsWith("/record.sh"))).toBe(true);
    expect(cmds("Stop").some((c: string) => c.endsWith("/format-on-stop.sh"))).toBe(true);
    expect(cmds("SubagentStop").some((c: string) => c.endsWith("/format-on-stop.sh"))).toBe(true);
    expect(cmds("SessionStart").some((c: string) => c.endsWith("/hcl-detect.sh"))).toBe(true);
    const matchers = (e: string, script: string): string[] =>
      (hooksConfig.hooks[e] ?? [])
        .filter((x: any) => x.hooks.some((h: any) => h.command.endsWith("/" + script)))
        .flatMap((x: any) => x.matcher.split("|"));
    // Standards gate: gates every file-editing tool, sees only Reads, resets on /clear and compaction.
    expect(matchers("PreToolUse", "standards-check.sh").sort()).toEqual(["Edit", "MultiEdit", "Write"]);
    expect(matchers("PostToolUse", "standards-seen.sh")).toEqual(["Read"]);
    expect(matchers("SessionStart", "standards-reset.sh").sort()).toEqual(["clear", "compact"]);
    // State cleanup prunes at every session start and sees every SessionEnd (the script decides on reason).
    expect(matchers("SessionStart", "state-cleanup.sh").sort()).toEqual(["clear", "compact", "resume", "startup"]);
    expect(cmds("SessionEnd").some((c: string) => c.endsWith("/state-cleanup.sh"))).toBe(true);
    const all = Object.values(hooksConfig.hooks).flat().flatMap((x: any) => x.hooks.map((h: any) => h.command));
    for (const dead of ["gofmt.sh","rustfmt.sh","eslint.sh","typescript.sh","clippy.sh","cargo-check.sh","hcl-record.sh","hcl-fmt.sh"]) {
      expect(all.some((c: string) => c.endsWith("/" + dead))).toBe(false);
    }
  });
});

describe("session-start.sh", () => {
  it("exits 0 and produces valid JSON with expected structure", async () => {
    const proc = Bun.spawn(["bash", resolve(KIT_CLAUDE_HOOKS_DIR, "session-start.sh")], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: process.env.HOME ?? "/tmp" },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const json = JSON.parse(stdout);
    expect(json).toHaveProperty("hookSpecificOutput");
    expect(json.hookSpecificOutput).toHaveProperty("hookEventName", "SessionStart");
    expect(json.hookSpecificOutput).toHaveProperty("additionalContext");
    expect(typeof json.hookSpecificOutput.additionalContext).toBe("string");
  });
});
