// /reports:skills [RANGE] [--sun|--mon] | help: skill loads per skill and source, unused skills, and standards adoption.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerReportCommand } from "../../lib/command.ts";
import { parseArgs, runReport } from "./report.ts";

export default function skillsReport(pi: ExtensionAPI): void {
	registerReportCommand(
		pi,
		"reports:skills",
		"Skill loads per skill/source/project, failed reads, unused skills, and standards adoption (args: [RANGE] [--sun|--mon] | help)",
		argv => runReport(parseArgs(argv)),
	);
}
