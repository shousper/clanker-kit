// omp session transcripts (~/.omp/agent/sessions) and project naming, shared by the reports.
import { Glob } from "bun";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const SESSIONS_DIR = join(HOME, ".omp", "agent", "sessions");

export const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

/** Repository root of a working directory; worktrees under `.worktrees/` count as their repository. */
export const projectOf = (cwd: string) => cwd.replace(/\/\.worktrees\/.*$/, "");

export interface SessionFile {
	file: string;
	/** Top-level session file; a subagent transcript sits in a folder named after it. */
	top: string;
	isSub: boolean;
	size: number;
}

/** Transcripts that can hold entries in [start, end): skips files last written before `start` or created at or after `end`. */
export async function* sessionFiles(start: number, end: number): AsyncGenerator<SessionFile> {
	for await (const rel of new Glob("**/*.jsonl").scan({ cwd: SESSIONS_DIR })) {
		const file = join(SESSIONS_DIR, rel);
		const stat = statSync(file);
		if (stat.mtimeMs < start || stat.birthtimeMs >= end) continue;
		const parts = rel.split("/");
		const isSub = parts.length > 2;
		yield { file, top: isSub ? join(SESSIONS_DIR, parts[0], `${parts[1]}.jsonl`) : file, isSub, size: stat.size };
	}
}

/** Reads the `cwd` from a transcript's session header, which sits within its first few lines. */
export function headerCwd(file: string): string | undefined {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(16384);
		const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
		const line = head.split("\n").find(l => l.startsWith('{"type":"session",'));
		return line ? JSON.parse(line).cwd : undefined;
	} finally {
		closeSync(fd);
	}
}

const TIMESTAMP = '"timestamp":"';

/** Epoch ms of a transcript line's entry timestamp; NaN when it has none. */
export function lineTime(line: string): number {
	const tsAt = line.indexOf(TIMESTAMP);
	const tsEnd = tsAt < 0 ? -1 : line.indexOf('"', tsAt + TIMESTAMP.length);
	return tsEnd < 0 ? Number.NaN : Date.parse(line.slice(tsAt + TIMESTAMP.length, tsEnd));
}
