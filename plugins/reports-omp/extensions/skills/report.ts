#!/usr/bin/env bun
// Skill usage report over omp session transcripts (~/.omp/agent/sessions).
// Used by the /reports:skills extension command and runnable directly:
//   bun report.ts [RANGE] [--sun|--mon]    (see RANGE_HELP in ../../lib/range.ts)

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseRangeArgs } from "../../lib/args.ts";
import { type RenderedReport, type ReportResult, type Section, runCli } from "../../lib/command.ts";
import { periods } from "../../lib/period.ts";
import { RANGE_HELP, type WeekStart, describeRange, formatInstant, resolveRange } from "../../lib/range.ts";
import { HOME, headerCwd, lineTime, projectOf, sessionFiles, tilde } from "../../lib/sessions.ts";
import { INT, PCT, type Row, renderBox } from "../../lib/table.ts";

const GRAMMAR = `Usage: /reports:skills [RANGE] [--sun|--mon]

Counts skill loads in omp sessions: \`read skill://<name>\` calls by sessions and subagents, and
/skill:<name> invocations. Unused lists skills installed now, for any project active in RANGE,
that were never loaded. Standards counts, per agent and language, whether the code standards were
read before the first edit in a gated language.

${RANGE_HELP}`;

const OMP_WORKTREES = join(HOME, ".omp", "wt");

export interface ReportOptions {
	spec: string;
	weekStart: WeekStart;
	help: boolean;
}

type Kind = "plugin" | "project" | "user" | "other";

/** Where a skill file lives. `family` is `source` without a plugin version, so versions of one plugin match. */
interface Origin {
	kind: Kind;
	source: string;
	family: string;
	/** How a plugin is installed ("linked <target>", "installed", "cached"); "-" for other kinds. */
	install: string;
}

type Via = "main" | "subagent" | "user";

interface Load {
	skill: string;
	origin: Origin;
	via: Via;
	/** Top-level session file; subagent loads count toward their parent session. */
	session: string;
	at: number;
}

interface Failure {
	request: string;
	error: string;
	session: string;
	at: number;
}

interface Session {
	file: string;
	top: string;
	isSub: boolean;
	cwd?: string;
	active: boolean;
	/** Skill names listed in the session's system prompt; only subagent transcripts record it. */
	offered: Set<string>;
	/** Standards-gate events (edits, standards reads, gate blocks) in transcript order. */
	std: StdEvent[];
}

interface InstalledSkill {
	name: string;
	origin: Origin;
	hidden: boolean;
	description: string;
}

const packages = new Map<string, { version: string; link?: string }>();

/** Version and symlink target of an installed plugin package, read at report time. */
function pluginPackage(dir: string): { version: string; link?: string } {
	let pkg = packages.get(dir);
	if (!pkg) {
		const manifest = join(dir, "package.json");
		pkg = existsSync(manifest)
			? {
					version: JSON.parse(readFileSync(manifest, "utf8")).version ?? "?",
					link: lstatSync(dir).isSymbolicLink() ? realpathSync(dir) : undefined,
				}
			: { version: "?" };
		packages.set(dir, pkg);
	}
	return pkg;
}

const NODE_MODULES_PLUGIN = /^(.*\/\.omp\/plugins\/node_modules\/((?:@[^/]+\/)?[^/]+))\/skills\//;
const OMP_CACHE_PLUGIN = /\/\.omp\/plugins\/cache\/plugins\/[^/]*?___([^/]+?)___([^/]+)\/skills\//;
const CLAUDE_CACHE_PLUGIN = /\/\.claude\/plugins\/cache\/[^/]+\/([^/]+)\/([^/]+)\/skills\//;
const SKILLS_DIR = /^(.*\/[^/]*skills)\/[^/]+\//;

function originOf(path: string): Origin {
	const npm = NODE_MODULES_PLUGIN.exec(path);
	if (npm) {
		const pkg = pluginPackage(npm[1]);
		const install = pkg.link ? `linked ${tilde(pkg.link)}` : "installed";
		return { kind: "plugin", source: `${npm[2]}@${pkg.version}`, family: npm[2], install };
	}
	const ompCached = OMP_CACHE_PLUGIN.exec(path);
	if (ompCached) return { kind: "plugin", source: `${ompCached[1]}@${ompCached[2]}`, family: ompCached[1], install: "omp cache" };
	const claudeCached = CLAUDE_CACHE_PLUGIN.exec(path);
	if (claudeCached) {
		return { kind: "plugin", source: `${claudeCached[1]}@${claudeCached[2]}`, family: claudeCached[1], install: "claude cache" };
	}

	const skillsDir = SKILLS_DIR.exec(path)?.[1] ?? dirname(dirname(path));
	const root = dirname(skillsDir);
	if (root.startsWith(`${HOME}/.`) && !root.startsWith(OMP_WORKTREES)) {
		return { kind: "user", source: tilde(skillsDir), family: tilde(skillsDir), install: "-" };
	}
	if (basename(root).startsWith(".")) {
		const project = tilde(projectOf(dirname(root)));
		return { kind: "project", source: project, family: project, install: "-" };
	}
	return { kind: "other", source: tilde(skillsDir), family: tilde(skillsDir), install: "-" };
}

const skillKey = (name: string, origin: Origin) => `${name}\0${origin.kind}\0${origin.family}`;

// `read` path selectors (`:50-80`, `:raw`, …) are not part of the skill address.
const SELECTOR = /(?::(?:raw|img|conflicts|-?\d[\d,+-]*))+$/;
const SKILLS_BLOCK = /<skills>\n([\s\S]*?)\n<\/skills>/;

/** Runs `omp skill list --json` in `dir`, which applies omp's discovery, toggles and collision rules for it. */
async function installedSkills(dir: string): Promise<InstalledSkill[]> {
	const proc = Bun.spawn(["omp", "skill", "list", "--json"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`omp skill list failed in ${tilde(dir)} (exit ${code}): ${err.trim()}`);
	const skills: { name: string; description?: string; filePath: string; hide?: boolean }[] = JSON.parse(out).skills;
	return skills.map(s => ({
		name: s.name,
		origin: originOf(s.filePath),
		hidden: s.hide === true,
		description: s.description ?? "",
	}));
}

// Standards adoption: did an agent read a language's code standards before editing that language?
// kit's standards gate (shared/hooks/standards-gate.sh) blocks an agent's first edit in a language until it
// reads `code-standards/<lang>/CLAUDE.md`. The unit is a pair of one agent transcript (a top-level session or
// a subagent) and one language. Edits made through the shell are not visible in transcripts.

interface StandardsLang {
	id: string;
	label: string;
	/** Exact basenames the gate treats as this language. */
	names: string[];
	/** Basename suffixes the gate treats as this language. */
	suffixes: string[];
	/** Gated only inside a project with `tailwind.config.*` or a `tailwindcss` dependency. */
	tailwind?: true;
}

// Mirrors the language table in shared/hooks/standards-gate.sh. Python has no standards file and no gate, so
// it is not tracked: a "read" of a placeholder would measure nothing.
const STANDARDS_LANGS: StandardsLang[] = [
	{ id: "go", label: "Go", names: ["go.mod", "go.sum"], suffixes: [".go"] },
	{ id: "rust", label: "Rust", names: ["Cargo.toml"], suffixes: [".rs"] },
	{ id: "hcl", label: "HCL", names: [], suffixes: [".tf", ".tofu", ".tofu.json", ".tfvars"] },
	{
		id: "tailwindcss",
		label: "Tailwind CSS",
		names: [],
		suffixes: [".css", ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html"],
		tailwind: true,
	},
];

interface StdEvent {
	kind: "edit" | "read" | "block";
	lang: string;
	at: number;
	/** Kit root that holds the standards: from a block reason's path, or from the file a read resolved to. */
	root?: string;
}

/** A pending `edit`/`write`/`apply_patch` call or a read of a standards file, awaiting its toolResult. */
interface StdCall {
	kind: "edit" | "read";
	path?: string;
	paths: string[];
	lang?: string;
}

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };
const EDIT_CALL = /"name":"(?:edit|write|apply_patch)"/;
const TOOL_CALL_ID = /"toolCallId":"([^"]+)"/;
// A full read of a standards file: no `:50-80` range, no URL. `:raw` is still a full read, as in the gate.
const STANDARDS_PATH = /(?:^|\/)code-standards\/([a-z]+)\/CLAUDE\.md(?::raw)?$/;
const STANDARDS_TAIL = /\/code-standards\/[a-z]+\/CLAUDE\.md(?::raw)?$/;
// The gate's block reason: `kit: before editing FILE, read the LABEL standards in full at ROOT/code-standards/LANG/CLAUDE.md and follow ...`
const BLOCK_REASON = /^kit: before editing .+?, read the .+? standards in full at (.+)\/code-standards\/([a-z]+)\/CLAUDE\.md and follow /;
const TAILWIND_CONFIGS = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts"];

const tailwindDirs = new Map<string, boolean>();

function dirHasTailwind(dir: string): boolean {
	let hit = tailwindDirs.get(dir);
	if (hit === undefined) {
		hit = TAILWIND_CONFIGS.some(f => existsSync(join(dir, f)));
		if (!hit) {
			try {
				hit = readFileSync(join(dir, "package.json"), "utf8").includes('"tailwindcss"');
			} catch {
				hit = false;
			}
		}
		tailwindDirs.set(dir, hit);
	}
	return hit;
}

/** The gate's Tailwind signal, checked against the disk as it is now: any ancestor directory, up to `/`. */
function tailwindProject(dir: string): boolean {
	for (let d = dir; ; d = dirname(d)) {
		if (dirHasTailwind(d)) return true;
		if (dirname(d) === d) return false;
	}
}

function languageOf(file: string): string | undefined {
	const name = basename(file);
	for (const lang of STANDARDS_LANGS) {
		const matches = lang.names.includes(name) || lang.suffixes.some(s => name.endsWith(s));
		if (matches && (!lang.tailwind || tailwindProject(dirname(file)))) return lang.id;
	}
	return undefined;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The `details` of a successful edit-tool result, as far as paths go. */
interface EditDetails {
	path?: unknown;
	resolvedPath?: unknown;
	perFileResults?: { path?: unknown }[];
}

/**
 * Files a successful edit-tool call changed, absolute. Transcripts keep an `edit` call's raw `input` text, so the
 * paths the runtime derived come from the result: `details.path`, `details.perFileResults[].path` for batches,
 * and `details.resolvedPath` for `write`. The call's `path`/`paths` arguments are the fallback.
 */
function editedFiles(call: StdCall, details: EditDetails | undefined, cwd: string | undefined): string[] {
	const fromResult: unknown[] = Array.isArray(details?.perFileResults)
		? details.perFileResults.map(r => r?.path)
		: [details?.path ?? details?.resolvedPath];
	let raw = fromResult.filter(isText);
	if (raw.length === 0) raw = [call.path, ...call.paths].filter(isText);
	return [...new Set(raw.map(p => (isAbsolute(p) ? p : resolve(cwd ?? "/", p))))];
}

/**
 * Feeds one transcript line. An assistant line records its edit calls and standards reads in `calls`; the matching
 * toolResult turns one into an event. Failed reads and failed edits are no events, except an edit refused with the
 * gate's block reason, which is a `block`.
 */
function scanStandards(line: string, calls: Map<string, StdCall>, events: StdEvent[], cwd: string | undefined, at: number): void {
	if (line.includes('"role":"toolResult"')) {
		if (calls.size === 0) return;
		const id = TOOL_CALL_ID.exec(line)?.[1];
		const call = id === undefined ? undefined : calls.get(id);
		if (id === undefined || !call) return;
		calls.delete(id);
		const msg = JSON.parse(line).message;
		if (call.kind === "read") {
			if (msg.isError) return;
			const source: unknown = msg.details?.meta?.source?.value;
			const where = isText(source) && !source.includes("://") ? source : call.path;
			events.push({
				kind: "read",
				lang: call.lang!,
				at,
				root: isText(where) && isAbsolute(where) ? where.replace(STANDARDS_TAIL, "") : undefined,
			});
		} else if (msg.isError) {
			const reason = BLOCK_REASON.exec(msg.content?.[0]?.text ?? "");
			if (reason) events.push({ kind: "block", lang: reason[2], at, root: reason[1] });
		} else {
			for (const file of editedFiles(call, msg.details, cwd)) {
				const lang = languageOf(file);
				if (lang) events.push({ kind: "edit", lang, at });
			}
		}
		return;
	}
	if (!line.includes('"type":"toolCall"') || !(line.includes("CLAUDE.md") || EDIT_CALL.test(line))) return;
	const msg = JSON.parse(line).message;
	if (msg?.role !== "assistant") return;
	for (const part of msg.content ?? []) {
		if (part.type !== "toolCall") continue;
		const args = part.arguments ?? {};
		if (EDIT_TOOLS[part.name]) {
			calls.set(part.id, {
				kind: "edit",
				path: isText(args.path) ? args.path : undefined,
				paths: Array.isArray(args.paths) ? args.paths.filter(isText) : [],
			});
		} else if (part.name === "read" && isText(args.path) && !args.path.includes("://")) {
			const lang = STANDARDS_PATH.exec(args.path)?.[1];
			if (lang) calls.set(part.id, { kind: "read", path: args.path, paths: [], lang });
		}
	}
}

/** Standards events of one transcript file's text, as `collect` gathers them. */
export function scanStandardsFile(text: string, cwd?: string): StdEvent[] {
	const events: StdEvent[] = [];
	const calls = new Map<string, StdCall>();
	let sessionCwd = cwd;
	for (const line of text.split("\n")) {
		if (line.startsWith('{"type":"session",')) sessionCwd = JSON.parse(line).cwd ?? sessionCwd;
		else scanStandards(line, calls, events, sessionCwd, lineTime(line));
	}
	return events;
}

/** What one agent did in one language. Edited = readBefore + readLate + (edited with no read at all). */
export interface StdOutcome {
	lang: string;
	edited: boolean;
	/** Read the standards before the first successful edit. */
	readBefore: boolean;
	/** Edited, and read the standards only after the first edit. */
	readLate: boolean;
	blocked: boolean;
	/** Read the standards after the first gate block. */
	readAfterBlock: boolean;
	/** Kit root from the first block, else from the first read. */
	root?: string;
}

/** Pairs with a successful edit or a gate block in [start, end). Reads count wherever they fall in the transcript. */
export function standardsOutcomes(events: StdEvent[], start: number, end: number): StdOutcome[] {
	const inRange = (e: StdEvent) => e.at >= start && e.at < end;
	const outcomes: StdOutcome[] = [];
	for (const [lang, evs] of Map.groupBy(events, e => e.lang)) {
		const firstEdit = evs.findIndex(e => e.kind === "edit" && inRange(e));
		const firstBlock = evs.findIndex(e => e.kind === "block" && inRange(e));
		if (firstEdit < 0 && firstBlock < 0) continue;
		const reads = evs.flatMap((e, i) => (e.kind === "read" ? [i] : []));
		const readBefore = firstEdit >= 0 && reads.some(i => i < firstEdit);
		outcomes.push({
			lang,
			edited: firstEdit >= 0,
			readBefore,
			readLate: firstEdit >= 0 && !readBefore && reads.length > 0,
			blocked: firstBlock >= 0,
			readAfterBlock: firstBlock >= 0 && reads.some(i => i > firstBlock),
			root: firstBlock >= 0 ? evs[firstBlock].root : reads.length > 0 ? evs[reads[0]].root : undefined,
		});
	}
	return outcomes;
}

interface StdPair extends StdOutcome {
	isSub: boolean;
}

const NO_KIT_SIGNAL = "(no kit signal)";

/** Plugin installs as `name@version`, anything else as the checkout it lives in. */
function standardsSource(root: string | undefined): string {
	if (!root) return NO_KIT_SIGNAL;
	const origin = originOf(`${root}/skills/-/SKILL.md`);
	if (origin.kind === "plugin") return origin.source;
	return `repo ${tilde(projectOf(root.replace(/^\/System\/Volumes\/Data/, "").replace(/\/shared$/, "")))}`;
}

interface Collected {
	range: string;
	start: number;
	end: number;
	weekStart: WeekStart;
	sessions: Session[];
	loads: Load[];
	failures: Failure[];
	/** Successful reads of files inside a skill directory, keyed by skillKey. */
	fileReads: Map<string, number>;
	/** Latest system-prompt line length per skill name. */
	promptChars: Map<string, number>;
	/** Skills installed now, per existing project directory. */
	installed: Map<string, Map<string, InstalledSkill>>;
	missingProjects: string[];
	/** Project root per top-level session file; subagents belong to their parent's project. */
	projectByTop: Map<string, string>;
}

async function collect(opts: ReportOptions): Promise<Collected> {
	const now = new Date();
	const range = resolveRange(opts.spec, now, opts.weekStart);
	const [start, end] = [range.start.getTime(), range.end.getTime()];

	const sessions: Session[] = [];
	const loads: Load[] = [];
	const failures: Failure[] = [];
	const fileReads = new Map<string, number>();
	const promptChars = new Map<string, { chars: number; at: number }>();

	for await (const { file, top, isSub } of sessionFiles(start, end)) {
		const session: Session = {
			file,
			top,
			isSub,
			active: false,
			offered: new Set(),
			std: [],
		};
		sessions.push(session);

		const pending = new Map<string, { request: string; at: number }>();
		const stdCalls = new Map<string, StdCall>();
		for (const line of (await Bun.file(file).text()).split("\n")) {
			if (line.startsWith('{"type":"session",')) {
				session.cwd = JSON.parse(line).cwd;
				continue;
			}
			const at = lineTime(line);
			const inRange = at >= start && at < end;
			if (inRange) session.active = true;
			scanStandards(line, stdCalls, session.std, session.cwd, at);
			const maybeResult = pending.size > 0 && line.includes('"role":"toolResult"');
			if (!maybeResult && !line.includes("skill")) continue;

			const entry = JSON.parse(line);
			if (entry.type === "session_init") {
				const block = SKILLS_BLOCK.exec(entry.systemPrompt ?? "")?.[1] ?? "";
				for (const item of block.split("\n")) {
					if (!item.startsWith("- ")) continue;
					const name = item.slice(2, item.indexOf(":"));
					session.offered.add(name);
					if ((promptChars.get(name)?.at ?? -1) < at) promptChars.set(name, { chars: item.length + 1, at });
				}
				continue;
			}
			if (entry.type === "custom_message" && entry.customType === "skill-prompt" && inRange) {
				const { name, path } = entry.details ?? {};
				if (name && path) loads.push({ skill: name, origin: originOf(path), via: "user", session: session.top, at });
				continue;
			}
			const msg = entry.type === "message" ? entry.message : undefined;
			if (msg?.role === "assistant" && inRange) {
				for (const part of msg.content ?? []) {
					const path = part.type === "toolCall" && part.name === "read" ? part.arguments?.path : undefined;
					if (typeof path === "string" && path.startsWith("skill://")) {
						pending.set(part.id, { request: path.replace(SELECTOR, ""), at });
					}
				}
			} else if (msg?.role === "toolResult" && pending.has(msg.toolCallId)) {
				const call = pending.get(msg.toolCallId)!;
				pending.delete(msg.toolCallId);
				if (msg.isError) {
					const text: string = msg.content?.[0]?.text ?? "";
					const error = text.split(/[:\n]/)[0].trim().slice(0, 60) || "Error";
					failures.push({ request: call.request, error, session: session.top, at: call.at });
					continue;
				}
				const resolved: string | undefined = msg.details?.resolvedPath;
				if (!resolved) continue;
				const address = call.request.slice("skill://".length).replace(/\/+$/, "");
				const origin = originOf(resolved);
				if (resolved.endsWith("/SKILL.md")) {
					const skill = address.replace(/\/SKILL\.md$/, "");
					loads.push({ skill, origin, via: isSub ? "subagent" : "main", session: session.top, at: call.at });
				} else {
					const key = skillKey(address.split("/")[0], origin);
					fileReads.set(key, (fileReads.get(key) ?? 0) + 1);
				}
			}
		}
	}

	const active = sessions.filter(s => s.active);
	const cwdByFile = new Map(sessions.map(s => [s.file, s.cwd]));
	const projectByTop = new Map<string, string>();
	for (const s of sessions) {
		if (projectByTop.has(s.top)) continue;
		const cwd = cwdByFile.get(s.top) ?? (existsSync(s.top) ? headerCwd(s.top) : undefined) ?? s.cwd ?? "?";
		projectByTop.set(s.top, projectOf(cwd));
	}

	const projects = [...new Set(active.map(s => projectByTop.get(s.top)!))].sort();
	const missingProjects = projects.filter(p => !existsSync(p));
	const lists = await Promise.all(projects.filter(p => existsSync(p)).map(async p => [p, await installedSkills(p)] as const));
	const installed = new Map(lists.map(([p, skills]) => [p, new Map(skills.map(s => [s.name, s]))]));

	return {
		range: describeRange(opts.spec, range, now),
		start,
		end,
		weekStart: opts.weekStart,
		sessions: active,
		loads,
		failures,
		fileReads,
		promptChars: new Map([...promptChars].map(([name, v]) => [name, v.chars])),
		installed,
		missingProjects: missingProjects.map(tilde),
		projectByTop,
	};
}

const count = <T>(items: T[], key: (item: T) => string) => new Set(items.map(key)).size;
const topSkills = (loads: Load[], n: number) =>
	[...Map.groupBy(loads, l => l.skill)]
		.map(([skill, ls]) => [skill, ls.length] as const)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, n)
		.map(([skill, k]) => `${skill} (${INT.format(k)})`);

function leaderboard(c: Collected): string {
	const projectOfLoad = (l: Load) => c.projectByTop.get(l.session)!;
	const groups = [...Map.groupBy(c.loads, l => `${l.skill}\0${l.origin.source}`).values()].sort(
		(a, b) => b.length - a.length || a[0].skill.localeCompare(b[0].skill),
	);
	const viaCounts = (ls: Load[]) => (["main", "subagent", "user"] as const).map(v => [INT.format(ls.filter(l => l.via === v).length)]);
	const rows: Row[] = groups.map(ls => {
		const { skill, origin } = ls[0];
		return [
			[skill],
			[origin.kind],
			[origin.source],
			[INT.format(ls.length)],
			...viaCounts(ls),
			[INT.format(count(ls, l => l.session))],
			[INT.format(count(ls, projectOfLoad))],
			[INT.format(c.fileReads.get(skillKey(skill, origin)) ?? 0)],
			[formatInstant(new Date(Math.max(...ls.map(l => l.at))))],
		];
	});
	const total: Row = [
		["Total"],
		[""],
		[""],
		[INT.format(c.loads.length)],
		...viaCounts(c.loads),
		[INT.format(count(c.loads, l => l.session))],
		[INT.format(count(c.loads, projectOfLoad))],
		[INT.format([...c.fileReads.values()].reduce((a, b) => a + b, 0))],
		[""],
	];
	return renderBox(
		["Skill", "Kind", "Source", "Loads", "Main", "Subagent", "/skill", "Sessions", "Projects", "Files", "Last used"],
		[rows, [total]],
		[false, false, false, true, true, true, true, true, true, true, false],
	);
}

function bySource(c: Collected, available: InstalledSkill[]): string {
	const loadsBySource = Map.groupBy(c.loads, l => `${l.origin.kind}\0${l.origin.source}`);
	const usedKeys = new Set(c.loads.map(l => skillKey(l.skill, l.origin)));
	const origins = new Map<string, Origin>();
	for (const o of [...c.loads.map(l => l.origin), ...available.map(s => s.origin)]) origins.set(`${o.kind}\0${o.source}`, o);
	const kindOrder: Kind[] = ["plugin", "project", "user", "other"];
	const sorted = [...origins.entries()].sort(
		([a, oa], [b, ob]) =>
			kindOrder.indexOf(oa.kind) - kindOrder.indexOf(ob.kind) ||
			(loadsBySource.get(b)?.length ?? 0) - (loadsBySource.get(a)?.length ?? 0) ||
			oa.source.localeCompare(ob.source),
	);
	const groups = Map.groupBy(sorted, ([, o]) => o.kind);
	return renderBox(
		["Kind", "Source", "Install", "Skills used", "Loads", "Share"],
		[
			...kindOrder.flatMap(kind => {
				const entries = groups.get(kind);
				if (!entries) return [];
				return [
					entries.map(([key, o]): Row => {
						const ls = loadsBySource.get(key) ?? [];
						const installedCount = available.filter(s => s.origin.kind === o.kind && s.origin.source === o.source).length;
						return [
							[o.kind],
							[o.source],
							[o.install],
							[`${INT.format(count(ls, l => l.skill))} / ${installedCount > 0 ? INT.format(installedCount) : "-"}`],
							[INT.format(ls.length)],
							[c.loads.length > 0 ? PCT.format(ls.length / c.loads.length) : "-"],
						];
					}),
				];
			}),
			[
				[
					["Total"],
					[""],
					[""],
					[`${INT.format(available.filter(s => usedKeys.has(skillKey(s.name, s.origin))).length)} / ${INT.format(available.length)}`],
					[INT.format(c.loads.length)],
					["100%"],
				],
			],
		],
		[false, false, false, true, true, true],
	);
}

function byProject(c: Collected): string {
	const sessionsByProject = Map.groupBy(c.sessions, s => c.projectByTop.get(s.top)!);
	const loadsByProject = Map.groupBy(c.loads, l => c.projectByTop.get(l.session)!);
	const projects = [...sessionsByProject.keys()].sort(
		(a, b) => (loadsByProject.get(b)?.length ?? 0) - (loadsByProject.get(a)?.length ?? 0) || a.localeCompare(b),
	);
	return renderBox(
		["Project", "Sessions", "With loads", "Subagents", "Loads", "Top skills"],
		projects.map(p => {
			const ss = sessionsByProject.get(p)!;
			const ls = loadsByProject.get(p) ?? [];
			const top = topSkills(ls, 3);
			return [
				[
					[tilde(p)],
					[INT.format(ss.filter(s => !s.isSub).length)],
					[INT.format(count(ls, l => l.session))],
					[INT.format(ss.filter(s => s.isSub).length)],
					[INT.format(ls.length)],
					top.length > 0 ? top : ["-"],
				],
			];
		}),
		[false, true, true, true, true, false],
	);
}

function byPeriod(c: Collected): Section {
	const p = periods(c.start, c.end, c.weekStart);
	const buckets = [...Map.groupBy(c.loads, l => p.bucket(l.at))].sort((a, b) => a[0] - b[0]);
	const table = renderBox(
		[p.unit, "Loads", "Sessions", "Skills", "Top skill"],
		[
			buckets.map(([at, ls]): Row => [
				[p.label(at)],
				[INT.format(ls.length)],
				[INT.format(count(ls, l => l.session))],
				[INT.format(count(ls, l => l.skill))],
				topSkills(ls, 1),
			]),
		],
		[false, true, true, true, false],
	);
	return { heading: p.heading, table };
}

function failed(c: Collected): string {
	const groups = [...Map.groupBy(c.failures, f => `${f.request}\0${f.error}`).values()].sort(
		(a, b) => b.length - a.length || a[0].request.localeCompare(b[0].request),
	);
	return renderBox(
		["Request", "Error", "Count", "Sessions", "Last"],
		[
			groups.map((fs): Row => [
				[fs[0].request],
				[fs[0].error],
				[INT.format(fs.length)],
				[INT.format(count(fs, f => f.session))],
				[formatInstant(new Date(Math.max(...fs.map(f => f.at))))],
			]),
		],
		[false, false, true, true, false],
	);
}

function standardsRow(label: string, pairs: StdPair[]): Row {
	const n = (keep: (p: StdPair) => boolean) => INT.format(pairs.filter(keep).length);
	const notRead = (p: StdPair) => p.edited && !p.readBefore && !p.readLate;
	const edited = pairs.filter(p => p.edited).length;
	const readBefore = pairs.filter(p => p.readBefore).length;
	return [
		[label],
		[INT.format(pairs.length)],
		[INT.format(edited)],
		[INT.format(readBefore)],
		[n(p => p.readLate)],
		[n(p => notRead(p) && p.blocked)],
		[n(p => notRead(p) && !p.blocked)],
		[n(p => p.blocked)],
		[n(p => p.readAfterBlock)],
		[edited > 0 ? PCT.format(readBefore / edited) : "-"],
	];
}

function standards(pairs: StdPair[]): string {
	const bySize = <T>([ka, a]: [string, T[]], [kb, b]: [string, T[]]) => b.length - a.length || ka.localeCompare(kb);
	const label = (id: string) => STANDARDS_LANGS.find(l => l.id === id)?.label ?? id;
	return renderBox(
		["Group", "Pairs", "Edited", "Read first", "Read late", "Ignored block", "Never blocked", "Blocked", "Read after block", "Read first %"],
		[
			[standardsRow("All", pairs)],
			[standardsRow("Top-level", pairs.filter(p => !p.isSub)), standardsRow("Subagent", pairs.filter(p => p.isSub))],
			[...Map.groupBy(pairs, p => p.lang)].sort(bySize).map(([lang, ps]) => standardsRow(label(lang), ps)),
			[...Map.groupBy(pairs, p => standardsSource(p.root))].sort(bySize).map(([source, ps]) => standardsRow(source, ps)),
		],
		[false, true, true, true, true, true, true, true, true, true],
	);
}

function unused(c: Collected, available: InstalledSkill[]): { table: string; perSession: number } {
	const used = new Set(c.loads.map(l => skillKey(l.skill, l.origin)));
	const exposed = new Map<string, number>();
	for (const s of c.sessions) {
		const skills = c.installed.get(c.projectByTop.get(s.top)!);
		if (!skills) continue;
		const names = s.offered.size > 0 ? s.offered : [...skills.values()].filter(k => !k.hidden).map(k => k.name);
		for (const name of names) {
			const skill = skills.get(name);
			if (!skill) continue;
			const key = skillKey(name, skill.origin);
			exposed.set(key, (exposed.get(key) ?? 0) + 1);
		}
	}
	const rows = available
		.filter(s => !used.has(skillKey(s.name, s.origin)))
		.map(s => {
			const recorded = c.promptChars.get(s.name);
			const chars = s.hidden ? 0 : (recorded ?? `- ${s.name}: ${s.description}`.length + 1);
			const sessions = s.hidden ? 0 : (exposed.get(skillKey(s.name, s.origin)) ?? 0);
			return { s, chars, estimated: !s.hidden && recorded === undefined, sessions, context: chars * sessions };
		})
		.sort((a, b) => b.context - a.context || b.chars - a.chars || a.s.name.localeCompare(b.s.name));
	const perSession = rows.reduce((sum, r) => sum + r.chars, 0);
	const table = renderBox(
		["Skill", "Kind", "Source", "Prompt chars", "Exposed", "Context chars"],
		[
			rows.map(({ s, chars, estimated, sessions, context }): Row => [
				[s.name],
				[s.origin.kind],
				[s.origin.source],
				[s.hidden ? "-" : `${INT.format(chars)}${estimated ? "*" : ""}`],
				[s.hidden ? "-" : INT.format(sessions)],
				[s.hidden ? "-" : INT.format(context)],
			]),
			[
				[
					["Total"],
					[""],
					[""],
					[INT.format(perSession)],
					[""],
					[INT.format(rows.reduce((sum, r) => sum + r.context, 0))],
				],
			],
		],
		[false, false, false, true, true, true],
	);
	return { table, perSession };
}

export function renderReport(c: Collected): RenderedReport {
	const available = [
		...new Map([...c.installed.values()].flatMap(m => [...m.values()]).map(s => [skillKey(s.name, s.origin), s])).values(),
	];
	const main = c.sessions.filter(s => !s.isSub);
	const subs = c.sessions.filter(s => s.isSub);
	const summary = [
		`${INT.format(c.loads.length)} skill load${c.loads.length === 1 ? "" : "s"} in ${INT.format(count(c.loads, l => l.session))} of ${INT.format(main.length)} sessions`,
		`(${INT.format(subs.length)} subagents) across ${INT.format(count(c.sessions, s => c.projectByTop.get(s.top)!))} projects;`,
		`${INT.format(c.failures.length)} failed reads.`,
	].join(" ");

	const sections: Section[] = [];
	if (c.loads.length > 0) {
		sections.push({
			heading: "Leaderboard",
			table: leaderboard(c),
			legend: "Main/Subagent: loads by the model in sessions or subagents; /skill: loads you invoked. Files: other files read from the skill.",
		});
	}
	sections.push({
		heading: "By source",
		table: bySource(c, available),
		legend: "Skills used: distinct skills loaded / installed now. Plugin versions come from the installed package.json.",
	});
	sections.push({ heading: "By project", table: byProject(c) });
	if (c.loads.length > 0) sections.push(byPeriod(c));
	if (c.failures.length > 0) sections.push({ heading: "Failed reads", table: failed(c) });
	const pairs = c.sessions.flatMap(s => standardsOutcomes(s.std, c.start, c.end).map((o): StdPair => ({ ...o, isSub: s.isSub })));
	if (pairs.length > 0) {
		sections.push({
			heading: "Standards",
			table: standards(pairs),
			legend:
				"Pairs: one agent (a session or a subagent) and one language it edited or was blocked in. Edited = Read first + Read late + Ignored block + Never blocked. " +
				"Read first: read the standards before the first edit; Read late: only after it. " +
				"Ignored block: the gate blocked, the agent edited anyway and never read. " +
				"Never blocked: edited with no block and never read (no gate yet, the gate failed, or it did not fire in that agent). " +
				"Read after block: blocked pairs that read afterwards. Read first % = Read first / Edited. " +
				"Tailwind needs a Tailwind signal on disk now. Source: the kit root named by the block, else the standards file read. Ranged reads and shell edits are not counted.",
		});
	}

	const { table, perSession } = unused(c, available);
	const missing =
		c.missingProjects.length > 0 ? ` Skipped projects that no longer exist: ${c.missingProjects.join(", ")}.` : "";
	sections.push({
		heading: "Unused",
		table,
		legend:
			"Prompt chars: the skill's line in the system prompt (* = full description; no recorded prompt in range). " +
			"Exposed: sessions and subagents in range offered the skill. Context chars = prompt chars × exposed. " +
			`Unused skills add ${INT.format(perSession)} chars (≈${INT.format(Math.round(perSession / 4))} tokens) to each prompt.${missing}`,
	});

	return { title: `Skill usage, ${c.range}`, summary, sections };
}

export function parseArgs(argv: string[]): ReportOptions {
	const { flags: _, ...args } = parseRangeArgs(argv, GRAMMAR);
	return args;
}

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
	if (opts.help) return GRAMMAR;
	const collected = await collect(opts);
	return collected.sessions.length === 0 ? `No omp sessions in ${collected.range}.` : renderReport(collected);
}

if (import.meta.main) await runCli(argv => runReport(parseArgs(argv)));
