// Period breakdown shared by the reports: days up to a month, weeks up to half a year, then months.
import { type WeekStart, formatInstant } from "./range.ts";

export type PeriodUnit = "Day" | "Week of" | "Month";

export interface Periods {
	/** Column header for the period labels. */
	unit: PeriodUnit;
	/** Section heading, "By day", "By week" or "By month". */
	heading: string;
	/** Local start (epoch ms) of the period containing `at`. */
	bucket(at: number): number;
	/** Label for a period start returned by `bucket`. */
	label(at: number): string;
}

export function periods(start: number, end: number, weekStart: WeekStart): Periods {
	const days = (end - start) / 86_400_000;
	const unit: PeriodUnit = days <= 31 ? "Day" : days <= 26 * 7 ? "Week of" : "Month";
	return {
		unit,
		heading: `By ${unit === "Week of" ? "week" : unit.toLowerCase()}`,
		bucket(at) {
			const d = new Date(at);
			if (unit === "Month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
			const back = unit === "Week of" ? (d.getDay() - (weekStart === "mon" ? 1 : 0) + 7) % 7 : 0;
			return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
		},
		label(at) {
			return unit === "Month"
				? new Date(at).toLocaleString("en-US", { month: "short", year: "numeric" })
				: formatInstant(new Date(at)).replace(/ 00:00$/, "");
		},
	};
}
