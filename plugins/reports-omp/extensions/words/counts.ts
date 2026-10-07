// Word-count categories shared by report.ts and its scan.ts workers.
import type { WeekStart } from "../../lib/range.ts";
import type { SessionFile } from "../../lib/sessions.ts";

export type Category = "typed" | "pasted" | "prose" | "messages" | "tools" | "thinking" | "subagents";
export type Counts = Record<Category, number>;

export const emptyCounts = (): Counts => ({ typed: 0, pasted: 0, prose: 0, messages: 0, tools: 0, thinking: 0, subagents: 0 });

export interface ScanRequest {
	files: SessionFile[];
	start: number;
	end: number;
	weekStart: WeekStart;
}

/** Counts for one period (its `bucket` start) in one project. */
export interface Tally {
	bucket: number;
	project: string;
	counts: Counts;
}
