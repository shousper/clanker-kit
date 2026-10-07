// Time-range grammar shared by the reports. All arithmetic is local time; ranges are half-open [start, end).

export type WeekStart = "mon" | "sun";

export interface TimeRange {
	start: Date;
	end: Date;
}

/** What a token covers on its own. */
interface Span {
	start: Date;
	end: Date;
}

type PeriodUnit = "h" | "d" | "w" | "mo" | "y";

const ALIASES: Record<string, string> = {
	today: "d0",
	yesterday: "d-1",
	wtd: "w0",
	lw: "w-1",
	mtd: "mo0",
	lm: "mo-1",
	ytd: "y0",
	ly: "y-1",
};

// `mo` must precede `m` so months are not read as minutes.
const DURATION = /^(?:\d+(?:mo|s|m|h|d|w|y))+$/;
const DURATION_PART = /(\d+)(mo|s|m|h|d|w|y)/g;
const PERIOD = /^(h|d|w|mo|y)(0|-\d+)$/;
const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:t(\d{1,2}):(\d{2})(?::(\d{2}))?)?)?)?$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RANGE section of a command's help text; the command supplies its own usage line. */
export const RANGE_HELP = `RANGE (default 7d), local time, case-insensitive:
  Rolling, until now     10s 15m 1h 1h30m 7d 2w 3mo 1y   (m = minutes, mo = months)
  Calendar periods       h0 d0 w0 mo0 y0 = current unit to date; d-1 w-1 mo-2 … = whole past units
    aliases              today yesterday wtd lw mtd lm ytd ly
  Absolute               2026  2026-09  2026-09-14  2026-09-14T09:30[:15]  09:30 (today)
  Ranges A..B            2026-09-01..2026-09-15  mo-3..mo-1  09:00..12:30  2026-09-20T14:00..  2h..1h
                         Include A, exclude B: the range runs from where A starts to where B starts.
                         A missing side is open-ended; "now" is also accepted.

Weeks start on Monday; --sun/--mon or SHOUSPER_REPORTS_WEEK_START=sun|mon changes that.`;

/** Week start from SHOUSPER_REPORTS_WEEK_START (default Monday). */
export function weekStartFromEnv(): WeekStart {
	const value = process.env.SHOUSPER_REPORTS_WEEK_START?.toLowerCase() ?? "mon";
	if (value !== "mon" && value !== "sun") throw new Error(`SHOUSPER_REPORTS_WEEK_START must be "mon" or "sun", got "${value}".`);
	return value;
}

/** Same wall-clock time `months` months away, clamped to the target month's last day. */
function addMonths(date: Date, months: number): Date {
	const target = new Date(
		date.getFullYear(),
		date.getMonth() + months,
		1,
		date.getHours(),
		date.getMinutes(),
		date.getSeconds(),
		date.getMilliseconds(),
	);
	const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
	target.setDate(Math.min(date.getDate(), daysInMonth));
	return target;
}

function durationAgo(token: string, now: Date): Date {
	let t = new Date(now);
	for (const [, count, unit] of token.matchAll(DURATION_PART)) {
		const n = Number(count);
		switch (unit) {
			case "y":
				t = addMonths(t, -12 * n);
				break;
			case "mo":
				t = addMonths(t, -n);
				break;
			case "w":
				t.setDate(t.getDate() - 7 * n);
				break;
			case "d":
				t.setDate(t.getDate() - n);
				break;
			case "h":
				t = new Date(t.getTime() - n * 3_600_000);
				break;
			case "m":
				t = new Date(t.getTime() - n * 60_000);
				break;
			case "s":
				t = new Date(t.getTime() - n * 1_000);
				break;
		}
	}
	return t;
}

function periodStart(unit: PeriodUnit, offset: number, now: Date, weekStart: WeekStart): Date {
	const y = now.getFullYear();
	const m = now.getMonth();
	const d = now.getDate();
	switch (unit) {
		case "h":
			return new Date(y, m, d, now.getHours() + offset);
		case "d":
			return new Date(y, m, d + offset);
		case "w": {
			const daysIntoWeek = weekStart === "mon" ? (now.getDay() + 6) % 7 : now.getDay();
			return new Date(y, m, d - daysIntoWeek + 7 * offset);
		}
		case "mo":
			return new Date(y, m + offset, 1);
		case "y":
			return new Date(y + offset, 0, 1);
	}
}

/**
 * Span of an absolute date/time given its fields [year, month0, day, hour, minute, second];
 * `precision` is the index of the least significant field the token spelled out.
 */
function absoluteSpan(raw: string, fields: number[], precision: number): Span {
	const [y, mo, d, h, mi, s] = fields;
	const start = new Date(y, mo, d, h, mi, s);
	if (
		start.getFullYear() !== y ||
		start.getMonth() !== mo ||
		start.getDate() !== d ||
		start.getHours() !== h ||
		start.getMinutes() !== mi ||
		start.getSeconds() !== s
	) {
		throw new Error(`Invalid or nonexistent local date/time: ${raw}`);
	}
	const next = [...fields];
	next[precision] += 1;
	const [ny, nmo, nd, nh, nmi, ns] = next;
	return { start, end: new Date(ny, nmo, nd, nh, nmi, ns) };
}

function resolveToken(raw: string, now: Date, weekStart: WeekStart): Span {
	const token = ALIASES[raw] ?? raw;
	if (token === "now") return { start: now, end: now };

	if (DURATION.test(token)) {
		const at = durationAgo(token, now);
		return { start: at, end: now };
	}

	const period = PERIOD.exec(token);
	if (period) {
		const unit = period[1] as PeriodUnit;
		const offset = Number(period[2]);
		return {
			start: periodStart(unit, offset, now, weekStart),
			end: offset === 0 ? now : periodStart(unit, offset + 1, now, weekStart),
		};
	}

	const date = DATE.exec(token);
	if (date) {
		const [, y, mo, d, h, mi, s] = date;
		const fields = [Number(y), mo ? Number(mo) - 1 : 0, d ? Number(d) : 1, Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)];
		const precision = s ? 5 : h ? 4 : d ? 2 : mo ? 1 : 0;
		return absoluteSpan(raw, fields, precision);
	}

	const time = TIME.exec(token);
	if (time) {
		const [, h, mi, s] = time;
		const fields = [now.getFullYear(), now.getMonth(), now.getDate(), Number(h), Number(mi), Number(s ?? 0)];
		return absoluteSpan(raw, fields, s ? 5 : 4);
	}

	throw new Error(`Unrecognised range "${raw}". Try 7d, lw, mtd, 2026-09, mo-3..mo-1, or "help".`);
}

export function resolveRange(spec: string, now: Date, weekStart: WeekStart): TimeRange {
	const parts = spec.toLowerCase().split("..");
	let start: Date;
	let end: Date;
	if (parts.length === 1) {
		({ start, end } = resolveToken(parts[0], now, weekStart));
	} else if (parts.length === 2 && (parts[0] || parts[1])) {
		const [a, b] = parts;
		start = a ? resolveToken(a, now, weekStart).start : new Date(0);
		end = b ? resolveToken(b, now, weekStart).start : now;
	} else {
		throw new Error(`Invalid range "${spec}". Use A..B, A.. or ..B.`);
	}
	if (end > now) end = now;
	if (start >= end) throw new Error(`Range "${spec}" is empty or in the future.`);
	return { start, end };
}

export function formatInstant(d: Date): string {
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = d.getSeconds() ? `:${String(d.getSeconds()).padStart(2, "0")}` : "";
	return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}${ss}`;
}

/** "`lw`: Mon 21 Sep 2026 00:00 → Mon 28 Sep 2026 00:00", with "now" for an open end. */
export function describeRange(spec: string, range: TimeRange, now: Date): string {
	const end = range.end.getTime() === now.getTime() ? "now" : formatInstant(range.end);
	return `${spec}: ${formatInstant(range.start)} → ${end}`;
}

const DURATION_UNITS: Record<string, string> = { y: "year", mo: "month", w: "week", d: "day", h: "hour", m: "minute", s: "second" };
const PERIOD_PHRASES: Record<string, string> = {
	h0: "So far this hour",
	d0: "So far today",
	w0: "So far this week",
	mo0: "So far this month",
	y0: "So far this year",
	"d-1": "Yesterday",
	"w-1": "Last week",
	"mo-1": "Last month",
	"y-1": "Last year",
};
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Sentence lead-in for `range`: "Over the last 7 days", "Last week", "In September 2026", "Since Wed 30 Sep 2026 14:02", … */
export function rangePhrase(spec: string, range: TimeRange, now: Date): string {
	const token = ALIASES[spec.toLowerCase()] ?? spec.toLowerCase();
	if (DURATION.test(token)) {
		const parts = [...token.matchAll(DURATION_PART)].map(([, n, unit]) => `${n} ${DURATION_UNITS[unit]}${n === "1" ? "" : "s"}`);
		return `Over the last ${parts.length === 1 && parts[0].startsWith("1 ") ? parts[0].slice(2) : parts.join(" and ")}`;
	}
	if (PERIOD_PHRASES[token]) return PERIOD_PHRASES[token];

	const { start, end } = range;
	const day = formatInstant(start).replace(/ 00:00$/, "");
	const startsAtMidnight = formatInstant(start).endsWith(" 00:00");
	if (startsAtMidnight) {
		const y = start.getFullYear();
		const m = start.getMonth();
		const d = start.getDate();
		const ends = (next: Date) => end.getTime() === next.getTime();
		if (m === 0 && d === 1 && ends(new Date(y + 1, 0, 1))) return `In ${y}`;
		if (d === 1 && ends(new Date(y, m + 1, 1))) return `In ${FULL_MONTHS[m]} ${y}`;
		if (ends(new Date(y, m, d + 1))) return `On ${day}`;
	}
	if (end.getTime() === now.getTime()) return `Since ${day}`;
	return `From ${day} until ${formatInstant(end).replace(/ 00:00$/, "")}`;
}
