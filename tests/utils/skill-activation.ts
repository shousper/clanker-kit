/**
 * Detects whether a live agent activated a given skill from a harness's normalized
 * events. The harness-specific signal (a `Skill` tool call for Claude, a `skill://`
 * read for OMP) lives in the adapter and counts only calls whose result is not an
 * error; this module owns the shared policy: try the adapter's signal, fall back to
 * scanning `text` events (assistant prose only; adapters never emit tool output as
 * `text`) for the qualified name, and flag runs where a silent model fallback makes
 * the result untrustworthy.
 *
 * Skill keys may be bare kit names ("tdd") or plugin-namespaced ("stories:work").
 * Bare names belong to the kit plugin.
 */

import { resultFor, type Harness, type NormalizedEvent, type ToolCallEvent } from "./harness/types";

export interface ActivationCheck {
  activated: boolean;
  /** True when the run silently changed model mid-flight; the case must be discarded, not scored. */
  invalid: boolean;
  details: string;
}

/** "tdd" → {qualified: "kit:tdd", bare: "tdd"}; "stories:work" → {qualified: "stories:work", bare: "work"} */
function skillNames(skill: string): { qualified: string; bare: string } {
  const i = skill.indexOf(":");
  if (i === -1) return { qualified: `kit:${skill}`, bare: skill };
  return { qualified: skill, bare: skill.slice(i + 1) };
}

function describeToolCalls(events: NormalizedEvent[]): string {
  const calls = events
    .filter((e): e is ToolCallEvent => e.kind === "tool_call")
    .map((e) => `${e.tool}(${JSON.stringify(e.input).slice(0, 80)})${resultFor(events, e)?.isError ? " [failed]" : ""}`);
  return calls.length > 0 ? `Tools called: ${calls.join(", ")}` : "No tool calls found";
}

export function checkSkillActivation(harness: Harness, stdout: string, skill: string): ActivationCheck {
  const events = harness.parse(stdout);
  const invalid = events.some((e) => e.kind === "fallback");

  if (events.length === 0) return { activated: false, invalid, details: "No parseable events in output" };

  if (harness.skillActivationSignal(events, skill))
    return { activated: true, invalid, details: `${harness.id} activation signal matched for "${skill}"` };

  const { qualified } = skillNames(skill);
  for (const event of events) {
    if (event.kind === "text" && event.text.includes(qualified))
      return { activated: true, invalid, details: `Found "${qualified}" in assistant text` };
  }

  return { activated: false, invalid, details: describeToolCalls(events) };
}
