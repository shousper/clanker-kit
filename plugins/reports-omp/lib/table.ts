// Box-drawing tables shared by the reports.

/** One table cell; each entry is a line, so a cell can stack values vertically. */
export type Cell = string[];
export type Row = Cell[];

export const INT = new Intl.NumberFormat("en-US");
export const PCT = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Renders `groups` of rows with a divider between groups and none between rows inside a group. */
export function renderBox(headers: string[], groups: Row[][], rightAlign: boolean[]): string {
	const rows = groups.flat();
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.flatMap(r => r[i].map(l => l.length))));
	const line = (cells: string[]) =>
		`│ ${cells.map((c, i) => (rightAlign[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(" │ ")} │`;
	const rule = (l: string, m: string, r: string) => l + widths.map(w => "─".repeat(w + 2)).join(m) + r;

	const out = [rule("┌", "┬", "┐"), line(headers), rule("├", "┼", "┤")];
	groups.forEach((group, k) => {
		for (const row of group) {
			const height = Math.max(...row.map(c => c.length));
			for (let j = 0; j < height; j++) out.push(line(row.map(c => c[j] ?? "")));
		}
		if (k < groups.length - 1) out.push(rule("├", "┼", "┤"));
	});
	out.push(rule("└", "┴", "┘"));
	return out.join("\n");
}
