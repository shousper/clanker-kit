/**
 * Judges a live run against the standards gate's contract from a harness's normalized
 * events: the agent read every standards unit the case needs (scope, the language's core
 * unit, and its project unit when the case has that facet) before its first successful
 * edit, read each exactly once from the exact path the gate named (a stale copy under
 * another root does not count and is a violation), did not search for the files, and was
 * blocked at most once. Pure functions over events,
 * so the pass/fail logic is covered offline (tests/static/standards-trace.test.ts) and the
 * live eval (tests/evals/code-standards.test.ts) only supplies real streams.
 */

import { existsSync, realpathSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, relative, resolve } from "path";
import { resultFor, type Harness, type NormalizedEvent, type ToolCallEvent } from "./harness/types";
import { parseStreamJson } from "./stream-json";

export type StandardsLang = "go" | "rust" | "hcl" | "tailwindcss" | "python" | "cpp";

/** A standards file the gate asks for: scope, a language's core, or a language's project facet. */
export type StandardsUnit = "scope" | StandardsLang | `${StandardsLang}:project`;

/** The unit's path suffix under a plugin root. */
export function unitFile(unit: StandardsUnit): string {
  if (unit === "scope") return "code-standards/scope.md";
  const [lang, facet] = unit.split(":");
  return `code-standards/${lang}/${facet ?? "core"}.md`;
}

/** The units a case must read: scope and the core unit, plus the project unit for a project-facet case. */
export function unitsFor(lang: StandardsLang, facet?: "project"): StandardsUnit[] {
  return facet ? ["scope", lang, `${lang}:project`] : ["scope", lang];
}

interface LangSpec {
  /** Files the gate maps to this language (the project signal for Tailwind and for shared C and C++ files is the fixture's job). */
  file: RegExp;
}

export const STANDARDS_LANGS: Record<StandardsLang, LangSpec> = {
  go: { file: /(\.go|(^|\/)go\.(mod|sum))$/ },
  rust: { file: /(\.rs|(^|\/)(Cargo|clippy|rust-toolchain)\.toml)$/ },
  hcl: { file: /(\.(tf|tofu|tfvars)|\.tofu\.json)$/ },
  tailwindcss: { file: /\.(css|tsx|jsx|vue|svelte|astro|html)$/ },
  python: { file: /(\.pyi?|(^|\/)pyproject\.toml)$/ },
  cpp: { file: /(\.(cpp|cc|cxx|hpp|hh|hxx|ipp|tpp|inl|h|cmake)|(^|\/)(CMakeLists\.txt|CMakePresets\.json|\.clang-tidy|\.clang-format))$/ },
};

/** Substring of every gate block reason (shared/hooks/standards-gate.sh). */
export const GATE_BLOCK_MARKER = "kit: before editing";

/**
 * Tools that search or list files, per harness. A call to one of them that mentions
 * `code-standards` before the first edit means the agent hunted for the standards files
 * instead of reading the paths the gate's block names. `read` is judged separately: only a
 * read of a directory counts as navigation.
 */
export const SEARCH_TOOLS: Record<Harness["id"], readonly string[]> = {
  claude: ["Glob", "Grep", "Bash", "LS"],
  omp: ["glob", "grep", "find", "bash", "search", "eval"],
};

/** Where the run happened: the plugin root the gate names paths under, and the trial's working directory. */
export interface StandardsWhere {
  pluginRoot: string;
  cwd: string;
}

export interface StandardsAnalysis {
  /** Event index of each successful, full read of each unit's standards file. */
  reads: Record<string, number[]>;
  /** Event index of the result of the first successful edit of a file in the language; -1 if none. */
  firstEdit: number;
  /** Text of each gate block (an error result carrying GATE_BLOCK_MARKER). */
  blocks: string[];
  /** Paths of successful reads under code-standards/ that are not the exact file of a unit the run is held to. */
  strayReads: string[];
  /** The units the run is held to: the case's expected units plus any other unit a gate block named. An agent
   *  that edits a project file in a source-edit case is legitimately asked for the project facet too. */
  units: StandardsUnit[];
  /** `tool(arg)` of each search or listing that mentioned code-standards before the first successful edit. */
  searches: string[];
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

/** The text of a read call's path, with its trailing `:raw` and line-range selectors removed. */
function readTarget(harness: Harness, call: ToolCallEvent): { raw: string; path: string; ranged: boolean } | undefined {
  const raw = harness.id === "claude" ? call.input.file_path : call.input.path;
  if (call.tool !== (harness.id === "claude" ? "Read" : "read") || typeof raw !== "string") return undefined;
  let path = raw;
  let ranged = call.input.offset != null || call.input.limit != null;
  for (let m = /:(raw|[-+,\d]+)$/.exec(path); m; m = /:(raw|[-+,\d]+)$/.exec(path)) {
    if (m[1] !== "raw") ranged = true;
    path = path.slice(0, m.index);
  }
  return { raw, path, ranged };
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** A path under code-standards whose last segment has no extension: a directory listing, not a standards file. */
function isStandardsDirectory(path: string): boolean {
  return path.includes("code-standards") && !(path.replace(/\/+$/, "").split("/").pop() ?? "").includes(".");
}

/** The first string argument of a call that mentions the standards directory. */
function standardsMention(call: ToolCallEvent): string | undefined {
  for (const v of Object.values(call.input)) {
    const found = (Array.isArray(v) ? v : [v]).find((s): s is string => typeof s === "string" && s.includes("code-standards"));
    if (found) return found;
  }
  return undefined;
}

const clip = (s: string): string => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

const BLOCK_PATHS = /then retry this edit: (.+?)\. kit asks once/;

/** The unit a path names when it is a standards file under `pluginRoot`. */
function unitOfPluginPath(path: string, pluginRoot: string): StandardsUnit | undefined {
  const rel = relative(pluginRoot, path);
  if (rel === "code-standards/scope.md") return "scope";
  const m = /^code-standards\/([a-z]+)\/(core|project)\.md$/.exec(rel);
  if (!m || !(m[1] in STANDARDS_LANGS)) return undefined;
  return (m[2] === "core" ? m[1] : `${m[1]}:project`) as StandardsUnit;
}

export function analyseStandards(
  harness: Harness,
  events: NormalizedEvent[],
  lang: StandardsLang,
  units: StandardsUnit[],
  where: StandardsWhere,
): StandardsAnalysis {
  const indexOfResult = new Map<string, number>();
  const blocks: string[] = [];
  events.forEach((e, i) => {
    if (e.kind === "tool_result") indexOfResult.set(e.id, i);
    if (e.kind === "tool_result" && e.isError && e.text.includes(GATE_BLOCK_MARKER)) blocks.push(e.text);
  });
  const held = [...units];
  for (const block of blocks) {
    for (const path of BLOCK_PATHS.exec(block)?.[1].split(", ") ?? []) {
      const unit = unitOfPluginPath(path, where.pluginRoot);
      if (unit && !held.includes(unit)) held.push(unit);
    }
  }
  const analysis: StandardsAnalysis = { reads: Object.fromEntries(held.map((u) => [u, []])), firstEdit: -1, blocks, strayReads: [], searches: [], units: held };
  const expected = held.map((u): [StandardsUnit, string] => [u, join(where.pluginRoot, unitFile(u))]);
  const unitAt = (path: string): StandardsUnit | undefined => {
    const abs = resolve(where.cwd, path);
    return expected.find(([, file]) => samePath(abs, file))?.[0];
  };
  const searches: { at: number; text: string }[] = [];
  events.forEach((e, callAt) => {
    if (e.kind !== "tool_call") return;
    const target = readTarget(harness, e);
    const mention = target ? (isStandardsDirectory(target.path) ? target.raw : undefined) : SEARCH_TOOLS[harness.id].includes(e.tool) ? standardsMention(e) : undefined;
    if (mention) searches.push({ at: callAt, text: `${e.tool}(${clip(mention)})` });
    const result = resultFor(events, e);
    if (!result || result.isError) return;
    const at = indexOfResult.get(result.id) ?? -1;
    if (target) {
      const unit = unitAt(target.path);
      if (unit && !target.ranged) analysis.reads[unit].push(at);
      else if (!unit && !mention && target.raw.includes("code-standards/")) analysis.strayReads.push(target.raw);
    } else if (analysis.firstEdit === -1 && editedPaths(harness, e).some((p) => STANDARDS_LANGS[lang].file.test(p))) analysis.firstEdit = at;
  });
  analysis.searches = searches.filter((s) => analysis.firstEdit === -1 || s.at < analysis.firstEdit).map((s) => s.text);
  return analysis;
}

/** Every way the run broke the contract, empty when it held. */
export function standardsViolations(a: StandardsAnalysis, lang: StandardsLang, units: StandardsUnit[]): string[] {
  const out: string[] = [];
  if (a.firstEdit === -1) out.push(`no successful ${lang} edit through an edit tool (shell edits are not gated)`);
  for (const u of a.units) {
    const reads = a.reads[u] ?? [];
    if (reads.length !== 1) out.push(`expected exactly 1 successful read of ${unitFile(u)}, saw ${reads.length}`);
    else if (a.firstEdit !== -1 && reads[0] > a.firstEdit) out.push(`${u} was read after the first successful ${lang} edit`);
  }
  if (a.blocks.length > 1) out.push(`expected at most 1 gate block, saw ${a.blocks.length}`);
  for (const block of a.blocks) {
    for (const u of units) {
      if (!block.includes(unitFile(u))) out.push(`a block did not name ${unitFile(u)}: ${block.slice(0, 160)}`);
    }
  }
  for (const path of a.strayReads) out.push(`read a standards file that the gate did not name: ${path}`);
  for (const search of a.searches) out.push(`searched for standards files instead of reading the paths in the block: ${search}`);
  return out;
}

/**
 * The top-level agent's own gate state must end at `loaded` for every expected unit: the
 * gate itself, which compares physical paths, agrees that the agent read the right files.
 */
export function gateStateViolations(states: GateStates, topKey: string | undefined, units: StandardsUnit[]): string[] {
  if (!topKey) return ["no top-level session id in the stream"];
  return units.flatMap((u) => {
    const last = (states[topKey]?.[u] ?? []).at(-1);
    return last === "loaded" ? [] : [`gate state for ${u} ended at ${last ? `"${last}"` : "no state"}, expected "loaded"`];
  });
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

/** agent key -> unit -> recorded states in order, from the gate's state directory. */
export type GateStates = Record<string, Record<string, string[]>>;

export async function readGateStates(stateDir: string): Promise<GateStates> {
  const states: GateStates = {};
  const names = await readdir(stateDir).catch(() => [] as string[]);
  for (const name of names) {
    const m = /^standards-(.+)\.txt$/.exec(name);
    if (!m) continue;
    const perUnit: Record<string, string[]> = (states[m[1]] = {});
    for (const line of (await readFile(join(stateDir, name), "utf-8")).split("\n")) {
      const [unit, state] = line.trim().split(/\s+/);
      if (unit && unit !== "cpp-root" && state) (perUnit[unit] ??= []).push(state);
    }
  }
  return states;
}

/**
 * Delegation: only the top-level stream is observable (OMP's --mode json carries a
 * subagent's progress, not its tool calls), so judge the subagent from the gate's own
 * state. The top-level agent must have no state for any expected unit; some other agent
 * key must end at `loaded` for every expected unit, each after at most one `prompted`.
 * A subagent that edited without reading would have been blocked and ended at `prompted`,
 * so `loaded` plus a landed edit means it read before its edit stuck.
 */
export function delegationViolations(
  states: GateStates,
  topKey: string | undefined,
  lang: StandardsLang,
  units: StandardsUnit[] = unitsFor(lang),
): string[] {
  const out: string[] = [];
  if (!topKey) return ["no top-level session id in the stream"];
  const touched = units.filter((u) => (states[topKey]?.[u] ?? []).length > 0);
  if (touched.length > 0) out.push(`the top-level agent touched ${touched.join(", ")} itself; the subagent path was not exercised`);
  const subs = Object.entries(states).filter(([key]) => key !== topKey);
  const missing = new Map<string, StandardsUnit[]>();
  for (const [key, perUnit] of subs) {
    for (const unit of units) {
      const prompted = (perUnit[unit] ?? []).filter((x) => x === "prompted").length;
      if (prompted > 1) out.push(`subagent ${key} was blocked ${prompted} times on ${unit}`);
    }
    missing.set(key, units.filter((u) => (perUnit[u] ?? []).at(-1) !== "loaded"));
  }
  if (![...missing.values()].some((m) => m.length === 0)) {
    if (subs.length === 0) out.push("no subagent state was recorded (agents seen: none)");
    for (const [key, m] of missing) out.push(`subagent ${key} did not end at "loaded" for ${m.join(", ")}`);
  }
  return out;
}
