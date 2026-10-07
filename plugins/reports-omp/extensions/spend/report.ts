#!/usr/bin/env bun
// Token spend report over omp's stats database (~/.omp/stats.db).
// Used by the /reports:spend extension command and runnable directly:
//   bun report.ts [RANGE] [--sun|--mon] [--no-sync]    (see RANGE_HELP in ../../lib/range.ts)

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRangeArgs } from "../../lib/args.ts";
import { type RenderedReport, type ReportResult, runCli } from "../../lib/command.ts";
import { RANGE_HELP, type WeekStart, describeRange, resolveRange } from "../../lib/range.ts";
import { type Cell, INT, PCT, renderBox } from "../../lib/table.ts";

const GRAMMAR = `Usage: /reports:spend [RANGE] [--sun|--mon] [--no-sync]\n\n${RANGE_HELP}`;

const STATS_DB = join(homedir(), ".omp", "stats.db");

export interface ReportOptions {
	spec: string;
	weekStart: WeekStart;
	sync: boolean;
	help: boolean;
}

interface Usage {
	reqs: number;
	input: number;
	cInput: number;
	cacheRead: number;
	cCacheRead: number;
	cacheWrite: number;
	cCacheWrite: number;
	output: number;
	cOutput: number;
	total: number;
	cTotal: number;
}

interface ModelUsage extends Usage {
	provider: string;
	model: string;
}

interface ProviderUsage extends Usage {
	provider: string;
}

export interface Report {
	/** Human-readable resolved range, e.g. "lw: Mon 21 Sep 2026 00:00 → Mon 28 Sep 2026 00:00". */
	range: string;
	byModel: ModelUsage[];
	byProvider: ProviderUsage[];
	total: Usage;
}

// Token columns that can be not applicable for a provider (never reported).
const TOKEN_COLUMNS = [
	["input", "cInput"],
	["cacheRead", "cCacheRead"],
	["cacheWrite", "cCacheWrite"],
	["output", "cOutput"],
	["total", "cTotal"],
] as const;

const SUMS = `
	count(*) AS reqs,
	sum(input_tokens) AS input, sum(cost_input) AS cInput,
	sum(cache_read_tokens) AS cacheRead, sum(cost_cache_read) AS cCacheRead,
	sum(cache_write_tokens) AS cacheWrite, sum(cost_cache_write) AS cCacheWrite,
	sum(output_tokens) AS output, sum(cost_output) AS cOutput,
	sum(total_tokens) AS total, sum(cost_total) AS cTotal`;

// Requests that consumed no tokens (failed/aborted before any usage) are excluded.
const WHERE = "timestamp >= ?1 AND timestamp < ?2 AND total_tokens > 0";

/** Runs `omp stats --summary`, which ingests new session entries into stats.db. */
export async function syncStats(): Promise<void> {
	const proc = Bun.spawn(["omp", "stats", "--summary"], { stdout: "ignore", stderr: "pipe" });
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(`omp stats sync failed (exit ${code}): ${stderr.trim()}`);
}

export async function buildReport(opts: ReportOptions): Promise<Report> {
	if (opts.sync) await syncStats();
	const now = new Date();
	const range = resolveRange(opts.spec, now, opts.weekStart);
	const bounds: [number, number] = [range.start.getTime(), range.end.getTime()];
	const db = new Database(STATS_DB, { readonly: true });
	try {
		const byModel = db
			.query<ModelUsage, [number, number]>(
				`SELECT provider, model, ${SUMS} FROM messages WHERE ${WHERE} GROUP BY provider, model ORDER BY cTotal DESC, total DESC`,
			)
			.all(...bounds);
		const byProvider = db
			.query<ProviderUsage, [number, number]>(
				`SELECT provider, ${SUMS} FROM messages WHERE ${WHERE} GROUP BY provider ORDER BY cTotal DESC, total DESC`,
			)
			.all(...bounds);
		const total = db.query<Usage, [number, number]>(`SELECT ${SUMS} FROM messages WHERE ${WHERE}`).get(...bounds)!;
		return { range: describeRange(opts.spec, range, now), byModel, byProvider, total };
	} finally {
		db.close();
	}
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const TOKEN_HEADERS = ["Reqs", "Input", "Cache read", "Cache write", "Output", "Total"];

/** Token/$ cells; a column is "-" when `scope` (the provider's totals) never reports it. */
function usageCells(u: Usage, scope: Usage): Cell[] {
	return [
		[INT.format(u.reqs)],
		...TOKEN_COLUMNS.map(([tok, cost]) => (scope[tok] > 0 ? [INT.format(u[tok]), USD.format(u[cost])] : ["-", "-"])),
	];
}

export function renderReport(r: Report): RenderedReport {
	const title = `Token spend, ${r.range}`;
	const providerUsage = new Map(r.byProvider.map(p => [p.provider, p]));

	const byModel = renderBox(
		["Provider", "Model", ...TOKEN_HEADERS],
		r.byModel.map(m => [[[m.provider], [m.model], ...usageCells(m, providerUsage.get(m.provider)!)]]),
		[false, false, ...TOKEN_HEADERS.map(() => true)],
	);

	const byProvider = renderBox(
		["Provider", ...TOKEN_HEADERS, "Share"],
		[
			...r.byProvider.map(p => [
				[
					[p.provider],
					...usageCells(p, p),
					[PCT.format(p.total / r.total.total), r.total.cTotal > 0 ? PCT.format(p.cTotal / r.total.cTotal) : "-"],
				],
			]),
			[[["Total"], ...usageCells(r.total, r.total), ["100%", "100%"]]],
		],
		[false, ...TOKEN_HEADERS.map(() => true), true],
	);

	return {
		title,
		sections: [
			{ heading: "By model", table: byModel },
			{ heading: "By provider", table: byProvider, legend: "Share: top = % of tokens, bottom = % of $." },
		],
	};
}

export function parseArgs(argv: string[]): ReportOptions {
	// RANGE is validated up front, so a malformed one fails before a potentially slow stats sync.
	const { flags, ...args } = parseRangeArgs(argv, GRAMMAR, ["--no-sync"]);
	return { ...args, sync: !flags.has("--no-sync") };
}

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
	if (opts.help) return GRAMMAR;
	const report = await buildReport(opts);
	return report.byModel.length === 0 ? `No token usage for ${report.range}.` : renderReport(report);
}

if (import.meta.main) await runCli(argv => runReport(parseArgs(argv)));
