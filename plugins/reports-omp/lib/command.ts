// Rendering and command wiring shared by the reports: the same report prints to a terminal
// when a report.ts runs directly and posts to chat when its omp extension command runs.
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

export interface Section {
	heading: string;
	table: string;
	legend?: string;
}

export interface RenderedReport {
	title: string;
	summary?: string;
	sections: Section[];
	/** Closing line after the sections. */
	footer?: string;
}

/** Help text, an empty-range notice, or a full report. */
export type ReportResult = RenderedReport | string;

export function reportText(result: ReportResult): string {
	if (typeof result === "string") return result;
	const head = result.summary ? `${result.title}\n${result.summary}` : result.title;
	const body = result.sections.map(s => `${s.heading}\n${s.table}${s.legend ? `\n${s.legend}` : ""}`);
	return [head, ...body, ...(result.footer ? [result.footer] : [])].join("\n\n");
}

function reportMarkdown(result: ReportResult): string {
	if (typeof result === "string") return `\`\`\`\n${result}\n\`\`\``;
	const head = result.summary ? `**${result.title}**\n\n${result.summary}` : `**${result.title}**`;
	const body = result.sections.map(s => `${s.heading}${s.legend ? `. ${s.legend}` : ""}\n\n\`\`\`\n${s.table}\n\`\`\``);
	return [head, ...body, ...(result.footer ? [result.footer] : [])].join("\n\n");
}

/** Runs a report from the command line, exiting 1 with the message on failure. */
export async function runCli(run: (argv: string[]) => Promise<ReportResult>): Promise<void> {
	try {
		console.log(reportText(await run(process.argv.slice(2))));
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

/** Registers `/<name>`, posting the report to chat as a `<name>.report` message without starting a turn. */
export function registerReportCommand(
	pi: ExtensionAPI,
	name: string,
	description: string,
	run: (argv: string[], ctx: ExtensionCommandContext) => Promise<ReportResult>,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			try {
				const result = await run(args.trim().split(/\s+/).filter(Boolean), ctx);
				pi.sendMessage(
					{ customType: `${name}.report`, content: reportMarkdown(result), display: true, attribution: "user" },
					{ triggerTurn: false },
				);
			} catch (err) {
				ctx.ui.notify(`${name}: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
