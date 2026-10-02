import { describe, it, expect } from "bun:test";
import { isToolCall, toolSucceeded, type NormalizedEvent, type ToolCallEvent } from "../utils/harness/types";

describe("normalized event model", () => {
  it("identifies tool-call events", () => {
    const e: NormalizedEvent = { kind: "tool_call", tool: "read", input: { path: "skill://tdd" } };
    expect(isToolCall(e, "read")).toBe(true);
    expect(isToolCall(e, "Skill")).toBe(false);
  });

  it("does not treat text events as tool calls", () => {
    expect(isToolCall({ kind: "text", text: "read" }, "read")).toBe(false);
  });
});

describe("toolSucceeded", () => {
  const call: ToolCallEvent = { kind: "tool_call", tool: "read", input: {}, id: "t1" };

  it("is true only for a call whose own result is not an error", () => {
    expect(toolSucceeded([call, { kind: "tool_result", id: "t1", isError: false, text: "ok" }], call)).toBe(true);
    expect(toolSucceeded([call, { kind: "tool_result", id: "t1", isError: true, text: "File not found" }], call)).toBe(false);
  });

  it("does not borrow another call's result, and treats a missing result or id as failure", () => {
    const other: NormalizedEvent = { kind: "tool_result", id: "t2", isError: false, text: "ok" };
    expect(toolSucceeded([call, other], call)).toBe(false);
    expect(toolSucceeded([call], call)).toBe(false);
    const anon: ToolCallEvent = { kind: "tool_call", tool: "read", input: {} };
    expect(toolSucceeded([anon, { kind: "tool_result", id: "", isError: false, text: "" }], anon)).toBe(false);
  });
});
