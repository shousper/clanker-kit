import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { checkSkillActivation } from "../utils/skill-activation";
import { claude } from "../utils/harness/claude";
import { omp } from "../utils/harness/omp";
import { ROOT } from "../utils/paths";

const CLAUDE_FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/claude-skill-activation.jsonl"), "utf-8");
const OMP_FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/omp-skill-activation.jsonl"), "utf-8");
const OMP_FAILED_READ_FIXTURE = readFileSync(resolve(ROOT, "tests/fixtures/events/omp-failed-read.jsonl"), "utf-8");

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}

function streamLine(block: ContentBlock): string {
  return JSON.stringify({ type: "assistant", message: { content: [block] } });
}

/** A Claude `Skill` tool call and the user event carrying its outcome. */
function skillCallStream(skill: string, outcome: { isError: boolean } = { isError: false }): string {
  return [
    streamLine({ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill } }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: outcome.isError,
            content: outcome.isError ? `Unknown skill: ${skill}` : `Launching skill: ${skill}`,
          },
        ],
      },
    }),
  ].join("\n");
}

describe("checkSkillActivation", () => {
  it("detects activation for claude via the Skill tool call fixture", () => {
    const result = checkSkillActivation(claude, CLAUDE_FIXTURE, "tdd");
    expect(result.activated).toBe(true);
    expect(result.invalid).toBe(false);
  });

  it("detects activation for omp via the skill:// read fixture", () => {
    const result = checkSkillActivation(omp, OMP_FIXTURE, "tdd");
    expect(result.activated).toBe(true);
    expect(result.invalid).toBe(false);
  });

  it("matches a bare kit skill invoked bare", () => {
    const out = skillCallStream("tdd");
    expect(checkSkillActivation(claude, out, "tdd").activated).toBe(true);
  });

  it("matches a bare kit skill invoked namespaced", () => {
    const out = skillCallStream("kit:tdd");
    expect(checkSkillActivation(claude, out, "tdd").activated).toBe(true);
  });

  it("matches a namespaced stories skill invoked namespaced", () => {
    const out = skillCallStream("stories:work");
    expect(checkSkillActivation(claude, out, "stories:work").activated).toBe(true);
  });

  it("matches a namespaced stories skill invoked bare", () => {
    const out = skillCallStream("work");
    expect(checkSkillActivation(claude, out, "stories:work").activated).toBe(true);
  });

  it("falls back to the fully-qualified name in assistant text", () => {
    const out = streamLine({ type: "text", text: "I'll use stories:work for this." });
    expect(checkSkillActivation(claude, out, "stories:work").activated).toBe(true);
  });

  it("text fallback searches the kit-qualified name for bare skills", () => {
    const out = streamLine({ type: "text", text: "Loading kit:tdd now." });
    expect(checkSkillActivation(claude, out, "tdd").activated).toBe(true);
  });

  it("does not match a different skill", () => {
    const out = skillCallStream("stories:plan");
    expect(checkSkillActivation(claude, out, "stories:work").activated).toBe(false);
  });

  it("reports no parseable events on empty output", () => {
    const res = checkSkillActivation(claude, "", "tdd");
    expect(res.activated).toBe(false);
    expect(res.invalid).toBe(false);
    expect(res.details).toBe("No parseable events in output");
  });

  it("invalidates a run that silently changed model", () => {
    const stdout = '{"type":"retry_fallback_applied","from":"anthropic/claude-sonnet-4-5","to":"xai-oauth/grok-build"}';
    expect(checkSkillActivation(omp, stdout, "tdd").invalid).toBe(true);
  });

  it("does not count a Skill call that returned an error", () => {
    const out = skillCallStream("kit:tdd", { isError: true });
    expect(checkSkillActivation(claude, out, "tdd").activated).toBe(false);
  });

  it("does not count a Skill call the run never got a result for", () => {
    const out = streamLine({ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "kit:tdd" } });
    expect(checkSkillActivation(claude, out, "tdd").activated).toBe(false);
  });

  it("does not count a failed skill:// read on omp, and names the failure in the details", () => {
    const result = checkSkillActivation(omp, OMP_FAILED_READ_FIXTURE, "code-standards");
    expect(result.activated).toBe(false);
    expect(result.details).toContain("[failed]");
  });

  it("text fallback ignores tool output that merely mentions the skill", () => {
    const out = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/notes.md" } }] } }),
      JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "remember to load kit:tdd first" }] } }),
    ].join("\n");
    expect(checkSkillActivation(omp, out, "tdd").activated).toBe(false);
  });
});
