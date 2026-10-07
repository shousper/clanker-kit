// Command-line grammar shared by the reports: [RANGE] [--sun|--mon] [extra flags] | help.
import { type WeekStart, resolveRange, weekStartFromEnv } from "./range.ts";

export interface RangeArgs {
	spec: string;
	weekStart: WeekStart;
	help: boolean;
	/** The `extraFlags` that were given. */
	flags: Set<string>;
}

/**
 * Parses `argv`, accepting `extraFlags` besides the common options. RANGE defaults to 7d and is
 * resolved here, so a malformed one fails before any slow work. Errors on an unknown option include `grammar`.
 */
export function parseRangeArgs(argv: string[], grammar: string, extraFlags: readonly string[] = []): RangeArgs {
	const args: RangeArgs = { spec: "7d", weekStart: weekStartFromEnv(), help: false, flags: new Set() };
	let specSeen = false;
	for (const arg of argv) {
		if (extraFlags.includes(arg)) args.flags.add(arg);
		else if (arg === "--sun" || arg === "--mon") args.weekStart = arg === "--sun" ? "sun" : "mon";
		else if (arg === "help" || arg === "--help" || arg === "-h") args.help = true;
		else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}\n\n${grammar}`);
		else if (specSeen) throw new Error(`Only one RANGE is allowed; got "${args.spec}" and "${arg}".`);
		else {
			args.spec = arg;
			specSeen = true;
		}
	}
	if (!args.help) resolveRange(args.spec, new Date(), args.weekStart);
	return args;
}
