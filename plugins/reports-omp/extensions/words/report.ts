#!/usr/bin/env bun
// Words read and written in omp sessions, in book-sized units.
// Used by the /reports:words extension command and runnable directly:
//   bun report.ts [RANGE] [--sun|--mon]    (see RANGE_HELP in ../../lib/range.ts)

import { availableParallelism } from "node:os";
import { parseRangeArgs } from "../../lib/args.ts";
import { type RenderedReport, type ReportResult, runCli } from "../../lib/command.ts";
import { type Periods, periods } from "../../lib/period.ts";
import { RANGE_HELP, type WeekStart, describeRange, rangePhrase, resolveRange } from "../../lib/range.ts";
import { type SessionFile, sessionFiles, tilde } from "../../lib/sessions.ts";
import { INT, type Row, renderBox } from "../../lib/table.ts";
import { type Category, type Counts, type ScanRequest, type Tally, emptyCounts } from "./counts.ts";

const GRAMMAR = `Usage: /reports:words [RANGE] [--sun|--mon]

Counts the words you typed into omp sessions and the words shown to you in reply, in book-sized units.
Wrote = your messages, minus pasted <attachment> blocks. Read = assistant prose + messages shown in chat.
Tool calls and results, thinking, and subagent transcripts are counted for information only.

${RANGE_HELP}`;

/** Average silent reading speed for non-fiction (Brysbaert 2019). */
const READ_WPM = 238;

interface Book {
	one: string;
	many: string;
	words: number;
}

interface Unit extends Book {
	about: string;
}

/** Units for the tables, at typical genre lengths. */
const UNITS: Unit[] = [
	{ one: "page", many: "pages", words: 250, about: "a double-spaced manuscript page" },
	{ one: "short story", many: "short stories", words: 6_000, about: "The Yellow Wallpaper (~6,000)" },
	{ one: "novella", many: "novellas", words: 30_000, about: "Animal Farm (29,966)" },
	{ one: "novel", many: "novels", words: 90_000, about: "The Hobbit (95,356)" },
	{ one: "epic", many: "epics", words: 500_000, about: "The Lord of the Rings (481,103)" },
	{ one: "encyclopedia", many: "encyclopedias", words: 40_000_000, about: "Encyclopaedia Britannica (~40 million)" },
];

/** Units for the closing line, each a real text's length. */
const BOOKS: Book[] = [
	{ one: "Green Eggs and Ham", many: "Green Eggs and Hams", words: 802 },
	{ one: "Declaration of Independence", many: "Declarations of Independence", words: 1_334 },
	{ one: "US Constitution", many: "US Constitutions", words: 4_500 },
	{ one: "Animal Farm", many: "Animal Farms", words: 29_966 },
	{ one: "Great Gatsby", many: "Great Gatsbys", words: 47_094 },
	{ one: "Hobbit", many: "Hobbits", words: 95_356 },
	{ one: "Lord of the Rings", many: "Lords of the Rings", words: 481_103 },
	{ one: "War and Peace", many: "War and Peaces", words: 561_304 },
	{ one: "complete Harry Potter series", many: "complete Harry Potter series", words: 1_084_170 },
	{ one: "Encyclopaedia Britannica", many: "Encyclopaedia Britannicas", words: 40_000_000 },
];

const AMOUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "1.4 novellas": `words` in the largest unit it fills at least once, else in the smallest unit. */
function inUnits(words: number, units: Book[]): string {
	const unit = units.findLast(u => words >= u.words) ?? units[0];
	const amount = AMOUNT.format(words / unit.words);
	return `${amount} ${amount === "1" ? unit.one : unit.many}`;
}

export interface ReportOptions {
	spec: string;
	weekStart: WeekStart;
	help: boolean;
}

interface Collected {
	range: string;
	phrase: string;
	periods: Periods;
	tallies: Tally[];
}

function runWorker(request: ScanRequest): Promise<Tally[]> {
	const { promise, resolve, reject } = Promise.withResolvers<Tally[]>();
	const worker = new Worker(new URL("./scan.ts", import.meta.url));
	worker.onmessage = (event: MessageEvent<Tally[]>) => {
		worker.terminate();
		resolve(event.data);
	};
	worker.onerror = event => {
		worker.terminate();
		reject(new Error(`Session scan failed: ${event.message}`));
	};
	worker.postMessage(request);
	return promise;
}

async function collect(opts: ReportOptions): Promise<Collected> {
	const now = new Date();
	const range = resolveRange(opts.spec, now, opts.weekStart);
	const [start, end] = [range.start.getTime(), range.end.getTime()];

	const files: SessionFile[] = [];
	for await (const file of sessionFiles(start, end)) files.push(file);

	// Largest files first, each to the least-loaded worker, so the workers finish together.
	const batches = Array.from({ length: Math.min(availableParallelism(), files.length) }, () => ({
		size: 0,
		files: [] as SessionFile[],
	}));
	for (const file of files.sort((a, b) => b.size - a.size)) {
		const batch = batches.reduce((min, b) => (b.size < min.size ? b : min));
		batch.size += file.size;
		batch.files.push(file);
	}
	const results = await Promise.all(batches.map(b => runWorker({ files: b.files, start, end, weekStart: opts.weekStart })));

	return {
		range: describeRange(opts.spec, range, now),
		phrase: rangePhrase(opts.spec, range, now),
		periods: periods(start, end, opts.weekStart),
		tallies: results.flat(),
	};
}

function total(tallies: Tally[]): Counts {
	const sum = emptyCounts();
	for (const { counts } of tallies) for (const k of Object.keys(counts) as Category[]) sum[k] += counts[k];
	return sum;
}

const HEADERS = ["Typed", "Wrote ≈", "Prose", "Messages", "Read ≈", "Tools", "Thinking", "Subagents"];
const ALIGN = [false, ...HEADERS.map(() => true)];

function row(label: string, c: Counts): Row {
	const read = c.prose + c.messages;
	return [
		[label],
		[INT.format(c.typed)],
		[c.typed > 0 ? inUnits(c.typed, UNITS) : "-"],
		[INT.format(c.prose)],
		[INT.format(c.messages)],
		[read > 0 ? inUnits(read, UNITS) : "-"],
		[INT.format(c.tools)],
		[INT.format(c.thinking)],
		[INT.format(c.subagents)],
	];
}

function duration(minutes: number): string {
	if (minutes >= 60) return `${AMOUNT.format(minutes / 60)} hours`;
	const m = Math.round(minutes);
	return `${m} minute${m === 1 ? "" : "s"}`;
}

/** Closing-line amount: a real book's worth, or plain words when that rounds to nothing. */
function bookAmount(words: number): string {
	if (words === 0) return "nothing";
	const amount = inUnits(words, BOOKS);
	return amount.startsWith("0 ") ? `${INT.format(words)} word${words === 1 ? "" : "s"}` : amount;
}

export function renderReport(c: Collected): RenderedReport {
	const sum = total(c.tallies);
	const read = sum.prose + sum.messages;

	const byPeriod = [...Map.groupBy(c.tallies, t => t.bucket)].sort((a, b) => a[0] - b[0]);
	const byProject = [...Map.groupBy(c.tallies, t => t.project)]
		.map(([project, ts]) => [project, total(ts)] as const)
		.sort(
			([pa, a], [pb, b]) =>
				b.prose + b.messages - (a.prose + a.messages) || b.typed - a.typed || b.subagents - a.subagents || pa.localeCompare(pb),
		);

	const pasted =
		sum.pasted > 0
			? ` Pasted <attachment> blocks (${INT.format(sum.pasted)} words) are left out of Typed; inline pastes cannot be told apart from typing.`
			: "";

	return {
		title: `Words read and written, ${c.range}`,
		summary:
			`Read ${inUnits(read, UNITS)} (${INT.format(read)} words, about ${duration(read / READ_WPM)} at ${READ_WPM} wpm). ` +
			`Wrote ${inUnits(sum.typed, UNITS)} (${INT.format(sum.typed)} words).`,
		sections: [
			{
				heading: c.periods.heading,
				table: renderBox(
					[c.periods.unit, ...HEADERS],
					[byPeriod.map(([at, ts]) => row(c.periods.label(at), total(ts))), [row("Total", sum)]],
					ALIGN,
				),
				legend:
					"Typed: your messages. Prose: assistant replies. Messages: notices shown in chat, such as subagent results, IRC and skill prompts. " +
					`Wrote ≈ is Typed and Read ≈ is Prose + Messages, in units. Tools (calls and results), Thinking and Subagents (whole subagent transcripts) are for information only.${pasted}`,
			},
			{
				heading: "By project",
				table: renderBox(
					["Project", ...HEADERS],
					[byProject.map(([project, counts]) => row(tilde(project), counts))],
					ALIGN,
				),
			},
			{
				heading: "Units",
				table: renderBox(
					["Unit", "Words", "About"],
					[UNITS.map(u => [[u.one], [INT.format(u.words)], [u.about]])],
					[false, true, false],
				),
				legend: "Each amount uses the largest unit it fills at least once.",
			},
		],
		footer: `${c.phrase}, you wrote ${bookAmount(sum.typed)} and read ${bookAmount(read)}.`,
	};
}

export function parseArgs(argv: string[]): ReportOptions {
	const { flags: _, ...args } = parseRangeArgs(argv, GRAMMAR);
	return args;
}

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
	if (opts.help) return GRAMMAR;
	const collected = await collect(opts);
	const sum = total(collected.tallies);
	return Object.values(sum).every(n => n === 0) ? `No conversation in ${collected.range}.` : renderReport(collected);
}

if (import.meta.main) await runCli(argv => runReport(parseArgs(argv)));
