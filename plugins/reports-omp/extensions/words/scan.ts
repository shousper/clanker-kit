// Worker for report.ts: counts words per category, period and project in a batch of session transcripts.
import { existsSync, readFileSync } from "node:fs";
import { periods } from "../../lib/period.ts";
import { headerCwd, lineTime, projectOf } from "../../lib/sessions.ts";
import { type ScanRequest, type Tally, emptyCounts } from "./counts.ts";

declare const self: Worker;

const ATTACHMENT = /<attachment\b[^>]*>([\s\S]*?)<\/attachment>/g;

/** Runs of non-whitespace; control characters also separate words. */
function words(text: string): number {
	let n = 0;
	let inWord = false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		const space =
			c <= 32 ||
			c === 0xa0 ||
			c === 0x1680 ||
			(c >= 0x2000 && c <= 0x200a) ||
			c === 0x2028 ||
			c === 0x2029 ||
			c === 0x202f ||
			c === 0x205f ||
			c === 0x3000 ||
			c === 0xfeff;
		if (!space && !inWord) n++;
		inWord = !space;
	}
	return n;
}

/** Words in the string values of tool call arguments; keys are not counted. */
function argumentWords(value: unknown): number {
	if (typeof value === "string") return words(value);
	if (typeof value !== "object" || value === null) return 0;
	let n = 0;
	for (const v of Object.values(value)) n += argumentWords(v);
	return n;
}

interface Part {
	type: string;
	text?: string;
	thinking?: string;
	arguments?: unknown;
}

function scan({ files, start, end, weekStart }: ScanRequest): Tally[] {
	const bucketOf = periods(start, end, weekStart).bucket;
	const tallies = new Map<string, Tally>();
	const cwdByTop = new Map<string, string>();

	for (const { file, top, isSub } of files) {
		let cwd = cwdByTop.get(top);
		if (cwd === undefined) {
			cwd = headerCwd(existsSync(top) ? top : file) ?? "?";
			cwdByTop.set(top, cwd);
		}
		const project = projectOf(cwd);

		for (const line of readFileSync(file, "utf8").split("\n")) {
			const isMessage = line.startsWith('{"type":"message"');
			if (!isMessage && !line.startsWith('{"type":"custom_message"')) continue;
			const at = lineTime(line);
			if (!(at >= start && at < end)) continue;

			const entry = JSON.parse(line);
			const bucket = bucketOf(at);
			const key = `${bucket}\0${project}`;
			let tally = tallies.get(key);
			if (!tally) {
				tally = { bucket, project, counts: emptyCounts() };
				tallies.set(key, tally);
			}
			const counts = tally.counts;

			if (!isMessage) {
				const content: string | Part[] = entry.content ?? "";
				const n = typeof content === "string" ? words(content) : content.reduce((s, p) => s + words(p.text ?? ""), 0);
				if (isSub) counts.subagents += n;
				else if (entry.display) counts.messages += n;
				continue;
			}

			const { role, content = [] } = entry.message as { role: string; content?: Part[] | string };
			const parts: Part[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
			for (const part of parts) {
				if (role === "user" && part.type === "text") {
					const text = part.text ?? "";
					if (isSub) {
						counts.subagents += words(text);
						continue;
					}
					let pasted = 0;
					const typed = text.replace(ATTACHMENT, (_, inner: string) => {
						pasted += words(inner);
						return " ";
					});
					counts.typed += words(typed);
					counts.pasted += pasted;
				} else if (role === "assistant" || role === "toolResult") {
					const n =
						part.type === "text"
							? words(part.text ?? "")
							: part.type === "thinking"
								? words(part.thinking ?? "")
								: part.type === "toolCall"
									? argumentWords(part.arguments)
									: 0;
					if (isSub) counts.subagents += n;
					else if (role === "toolResult" || part.type === "toolCall") counts.tools += n;
					else if (part.type === "text") counts.prose += n;
					else counts.thinking += n;
				}
			}
		}
	}
	return [...tallies.values()];
}

self.onmessage = (event: MessageEvent<ScanRequest>) => self.postMessage(scan(event.data));
