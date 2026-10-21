/**
 * Judges a live run against the standards gate's contract from a harness's normalized
 * events: the agent read the language's standards before its first successful edit,
 * read them exactly once, and was blocked at most once. Pure functions over events, so
 * the pass/fail logic is covered offline (tests/static/standards-trace.test.ts) and the
 * live eval (tests/evals/code-standards.test.ts) only supplies real streams.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { resultFor, type Harness, type NormalizedEvent, type ToolCallEvent } from "./harness/types";
import { parseStreamJson } from "./stream-json";

export type StandardsLang = "go" | "rust" | "hcl" | "tailwindcss" | "python" | "cpp";

interface LangSpec {
  /** Files the gate maps to this language (the project signal for Tailwind and for shared C and C++ files is the fixture's job). */
  file: RegExp;
}

export const STANDARDS_LANGS: Record<StandardsLang, LangSpec> = {
  go: { file: /(\.go|(^|\/)go\.(mod|sum))$/ },
  rust: { file: /(\.rs|(^|\/)Cargo\.toml)$/ },
  hcl: { file: /(\.(tf|tofu|tfvars)|\.tofu\.json)$/ },
  tailwindcss: { file: /\.(css|tsx|jsx|vue|svelte|astro|html)$/ },
  python: { file: /(\.pyi?|(^|\/)pyproject\.toml)$/ },
  cpp: { file: /(\.(cpp|cc|cxx|hpp|hh|hxx|ipp|tpp|inl|h|cmake)|(^|\/)(CMakeLists\.txt|CMakePresets\.json))$/ },
};

/** Substring of every gate block reason (shared/hooks/standards-gate.sh). */
export const GATE_BLOCK_MARKER = "kit: before editing";

export interface StandardsAnalysis {
  /** Event index of each successful, full read of the language's standards file. */
  reads: number[];
  /** Event index of the result of the first successful edit of a file in the language; -1 if none. */
  firstEdit: number;
  /** Text of each gate block (an error result carrying GATE_BLOCK_MARKER). */
  blocks: string[];
}

const EDIT_HEADER = /^\[([^\]\n#]+)(?:#[^\]\n]*)?\]$/gm;

/** Files an edit-type tool call targets, from the raw arguments the model wrote. */
function editedPaths(harness: Harness, call: ToolCallEvent): string[] {
  const i = call.input;
  if (harness.id === "claude") {
    return ["Edit", "Write", "MultiEdit"].includes(call.tool) && typeof i.file_path === "string" ? [i.file_path] : [];
  }
  if (!["edit", "write", "ast_edit"].includes(call.tool)) return [];
  const paths: string[] = [];
  if (typeof i.path === "string") paths.push(i.path);
  if (Array.isArray(i.paths)) paths.push(...i.paths.filter((p): p is string => typeof p === "string"));
  // OMP's edit tool carries the file in a `[path#TAG]` header inside `input`.
  if (typeof i.input === "string") paths.push(...[...i.input.matchAll(EDIT_HEADER)].map((m) => m[1]));
  return paths;
}

/** A read of the language's standards file with no line range or offset/limit. */
function isStandardsRead(harness: Harness, call: ToolCallEvent, lang: StandardsLang): boolean {
  const path = harness.id === "claude" ? call.input.file_path : call.input.path;
  if (call.tool !== (harness.id === "claude" ? "Read" : "read") || typeof path !== "string") return false;
  if (call.input.offset != null || call.input.limit != null) return false;
  return new RegExp(`code-standards/${lang}/CLAUDE\\.md(:raw)?$`).test(path);
}

export function analyseStandards(harness: Harness, events: NormalizedEvent[], lang: StandardsLang): StandardsAnalysis {
  const analysis: StandardsAnalysis = { reads: [], firstEdit: -1, blocks: [] };
  const indexOfResult = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.kind === "tool_result") indexOfResult.set(e.id, i);
    if (e.kind === "tool_result" && e.isError && e.text.includes(GATE_BLOCK_MARKER)) analysis.blocks.push(e.text);
  });
  for (const e of events) {
    if (e.kind !== "tool_call") continue;
    const result = resultFor(events, e);
    if (!result || result.isError) continue;
    const at = indexOfResult.get(result.id) ?? -1;
    if (isStandardsRead(harness, e, lang)) analysis.reads.push(at);
    else if (analysis.firstEdit === -1 && editedPaths(harness, e).some((p) => STANDARDS_LANGS[lang].file.test(p))) analysis.firstEdit = at;
  }
  return analysis;
}

/** Every way the run broke the contract, empty when it held. */
export function standardsViolations(a: StandardsAnalysis, lang: StandardsLang): string[] {
  const out: string[] = [];
  if (a.firstEdit === -1) out.push(`no successful ${lang} edit through an edit tool (shell edits are not gated)`);
  if (a.reads.length !== 1) out.push(`expected exactly 1 successful read of code-standards/${lang}/CLAUDE.md, saw ${a.reads.length}`);
  else if (a.firstEdit !== -1 && a.reads[0] > a.firstEdit) out.push(`the standards were read after the first successful ${lang} edit`);
  if (a.blocks.length > 1) out.push(`expected at most 1 gate block, saw ${a.blocks.length}`);
  for (const block of a.blocks) {
    if (!block.includes(`code-standards/${lang}/CLAUDE.md`)) out.push(`a block did not name code-standards/${lang}/CLAUDE.md: ${block.slice(0, 160)}`);
  }
  return out;
}

/** One line per tool call with its outcome, for failure reports. */
export function renderTrace(events: NormalizedEvent[]): string {
  const lines = events.flatMap((e) => {
    if (e.kind !== "tool_call") return [];
    const first = String(e.input.file_path ?? e.input.path ?? e.input.command ?? e.input.input ?? "").split("\n")[0];
    const target = first.length > 70 ? `…${first.slice(-69)}` : first;
    const r = resultFor(events, e);
    const outcome = !r ? "no result" : r.isError ? `ERROR ${r.text.slice(0, 160).replace(/\n/g, " ")}` : "ok";
    return [`    ${e.tool}(${target}) -> ${outcome}`];
  });
  return lines.length > 0 ? lines.join("\n") : "    (no tool calls)";
}

/** The top-level agent's session id: the key the gate files its state under. */
export function topLevelSessionId(harness: Harness, stdout: string): string | undefined {
  for (const ev of parseStreamJson(stdout)) {
    if (harness.id === "claude" && ev.type === "system" && ev.subtype === "init") return ev.session_id;
    if (harness.id === "omp" && ev.type === "session") return ev.id;
  }
  return undefined;
}

/** agent key -> language -> recorded states in order, from the gate's state directory. */
export type GateStates = Record<string, Partial<Record<StandardsLang, string[]>>>;

export async function readGateStates(stateDir: string): Promise<GateStates> {
  const states: GateStates = {};
  const names = await readdir(stateDir).catch(() => [] as string[]);
  for (const name of names) {
    const m = /^standards-(.+)\.txt$/.exec(name);
    if (!m) continue;
    const perLang: Partial<Record<StandardsLang, string[]>> = (states[m[1]] = {});
    for (const line of (await readFile(join(stateDir, name), "utf-8")).split("\n")) {
      const [lang, state] = line.trim().split(/\s+/);
      if (lang in STANDARDS_LANGS && state) (perLang[lang as StandardsLang] ??= []).push(state);
    }
  }
  return states;
}

/**
 * Delegation: only the top-level stream is observable (OMP's --mode json carries a
 * subagent's progress, not its tool calls), so judge the subagent from the gate's own
 * state. The top-level agent must have no state for the language; some other agent key
 * must end at `loaded` after at most one `prompted`. A subagent that edited without
 * reading would have been blocked and ended at `prompted`, so `loaded` plus a landed edit
 * means it read before its edit stuck.
 */
export function delegationViolations(states: GateStates, topKey: string | undefined, lang: StandardsLang): string[] {
  const out: string[] = [];
  if (!topKey) return ["no top-level session id in the stream"];
  if ((states[topKey]?.[lang] ?? []).length > 0) out.push(`the top-level agent touched ${lang} itself (${states[topKey]?.[lang]?.join(", ")}); the subagent path was not exercised`);
  const subs = Object.entries(states).filter(([key]) => key !== topKey);
  for (const [key, perLang] of subs) {
    const prompted = (perLang[lang] ?? []).filter((x) => x === "prompted").length;
    if (prompted > 1) out.push(`subagent ${key} was blocked ${prompted} times`);
  }
  if (!subs.some(([, perLang]) => (perLang[lang] ?? []).at(-1) === "loaded"))
    out.push(`no subagent state ends at "${lang} loaded" (agents seen: ${subs.map(([k]) => k).join(", ") || "none"})`);
  return out;
}
