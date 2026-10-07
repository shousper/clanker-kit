// /reports:words [RANGE] [--sun|--mon] | help: words you read and wrote in omp sessions, in book-sized units.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerReportCommand } from "../../lib/command.ts";
import { parseArgs, runReport } from "./report.ts";

export default function wordsReport(pi: ExtensionAPI): void {
	registerReportCommand(
		pi,
		"reports:words",
		"Words you read and wrote per period and project, in book-sized units (args: [RANGE] [--sun|--mon] | help)",
		argv => runReport(parseArgs(argv)),
	);
}
