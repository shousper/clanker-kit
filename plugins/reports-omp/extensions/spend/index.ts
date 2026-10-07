// /reports:spend [RANGE] [--sun|--mon] [--no-sync] | help: token and API-equivalent $ spend per model and provider.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerReportCommand } from "../../lib/command.ts";
import { parseArgs, runReport } from "./report.ts";

export default function spendReport(pi: ExtensionAPI): void {
	registerReportCommand(
		pi,
		"reports:spend",
		"Token spend per model/provider with API-equivalent $ (args: [RANGE] [--sun|--mon] [--no-sync] | help)",
		async (argv, ctx) => {
			const opts = parseArgs(argv);
			if (opts.sync && !opts.help) ctx.ui.notify("Syncing omp stats…", "info");
			return runReport(opts);
		},
	);
}
