import { describe, it, expect, afterAll } from "bun:test";
import { join, resolve } from "path";
import { mkdtemp, mkdir, writeFile, utimes, stat, rm, readdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import { HOOKS_DIR, KIT_CLAUDE_HOOKS_DIR } from "../utils/paths";

const sharedScript = resolve(HOOKS_DIR, "state-cleanup.sh");
const claudeScript = resolve(KIT_CLAUDE_HOOKS_DIR, "state-cleanup.sh");
const HOUR = 3600;
const roots: string[] = [];

afterAll(async () => {
  for (const d of roots) await rm(d, { recursive: true, force: true });
});

async function setup(files: string[]): Promise<{ root: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "kit-cleanup-"));
  roots.push(root);
  const state = join(root, "kit/state");
  await mkdir(state, { recursive: true });
  for (const f of files) await writeFile(join(state, f), "x\n");
  return { root, state };
}

/** Backdates files relative to the mtime of a file just written, so the test reads no wall clock itself. */
async function age(state: string, reference: string, files: string[], hoursAgo: number): Promise<void> {
  const nowSec = (await stat(join(state, reference))).mtimeMs / 1000;
  const at = new Date((nowSec - hoursAgo * HOUR) * 1000);
  for (const f of files) await utimes(join(state, f), at, at);
}

async function spawn(cmd: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([Bun.which("bash") ?? "bash", ...cmd], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

const runShared = (state: string, args: string[], key?: string) =>
  spawn([sharedScript, ...args], { KIT_STATE_DIR: state, KIT_SCRATCH_KEY: key ?? "" });

const runClaude = (root: string, payload: string) => spawn([claudeScript], { CLAUDE_CONFIG_DIR: root }, payload);

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("shared state-cleanup.sh prune", () => {
  it("removes touched and standards files 48 hours old or older, keeps newer ones and other files", async () => {
    const { state } = await setup([
      "standards-old.txt", "touched-old.txt", "standards-new.txt", "touched-new.txt", "other-old.txt", "hcl-tool-old.json",
    ]);
    await age(state, "standards-new.txt", ["standards-old.txt", "touched-old.txt", "other-old.txt", "hcl-tool-old.json"], 49);
    await age(state, "standards-new.txt", ["standards-new.txt", "touched-new.txt"], 1);

    const { code } = await runShared(state, ["prune"]);

    expect(code).toBe(0);
    expect((await readdir(state)).sort()).toEqual(["hcl-tool-old.json", "other-old.txt", "standards-new.txt", "touched-new.txt"]);
  });

  it("keeps stale files in subdirectories", async () => {
    const { state } = await setup(["standards-new.txt"]);
    await mkdir(join(state, "notes"));
    await writeFile(join(state, "notes/standards-plan.txt"), "x\n");
    await age(state, "standards-new.txt", ["notes/standards-plan.txt"], 49);

    expect((await runShared(state, ["prune"])).code).toBe(0);

    expect(await exists(join(state, "notes/standards-plan.txt"))).toBe(true);
  });

  it("prunes through a symlinked state directory", async () => {
    const { root, state } = await setup(["standards-old.txt", "standards-new.txt"]);
    await age(state, "standards-new.txt", ["standards-old.txt"], 49);
    const link = join(root, "state-link");
    await symlink(state, link);

    expect((await runShared(link, ["prune"])).code).toBe(0);

    expect((await readdir(state)).sort()).toEqual(["standards-new.txt"]);
  });

  it("exits 0 when the state directory does not exist", async () => {
    const { root } = await setup([]);
    expect((await runShared(join(root, "missing"), ["prune"])).code).toBe(0);
  });
});

describe("shared state-cleanup.sh forget", () => {
  it("removes only the key's two files", async () => {
    const { state } = await setup(["standards-gone.txt", "touched-gone.txt", "standards-other.txt", "touched-other.txt", "standards-gone-agent.txt"]);

    const { code } = await runShared(state, ["forget"], "gone");

    expect(code).toBe(0);
    expect((await readdir(state)).sort()).toEqual(["standards-gone-agent.txt", "standards-other.txt", "touched-other.txt"]);
  });

  it("deletes nothing and exits 0 for an empty key or a key containing a slash", async () => {
    const files = ["standards-keep.txt", "touched-keep.txt"];
    const { root, state } = await setup(files);
    await writeFile(join(root, "kit/standards-x.txt"), "x\n");
    await writeFile(join(root, "kit/touched-x.txt"), "x\n");

    for (const key of ["", "../x", "a/b"]) expect((await runShared(state, ["forget"], key)).code).toBe(0);

    expect((await readdir(state)).sort()).toEqual(files);
    expect(await exists(join(root, "kit/standards-x.txt"))).toBe(true);
    expect(await exists(join(root, "kit/touched-x.txt"))).toBe(true);
  });

  it("exits 0 when the state directory does not exist", async () => {
    const { root } = await setup([]);
    expect((await runShared(join(root, "missing"), ["forget"], "k")).code).toBe(0);
  });
});

describe("shared state-cleanup.sh usage", () => {
  it("exits 64 with usage on stderr for an unknown or missing subcommand", async () => {
    const { state } = await setup(["standards-a.txt"]);
    for (const args of [["nope"], []]) {
      const { code, stderr } = await runShared(state, args, "a");
      expect(code).toBe(64);
      expect(stderr.length).toBeGreaterThan(0);
    }
    expect(await exists(join(state, "standards-a.txt"))).toBe(true);
  });
});

describe("Claude state-cleanup.sh adapter", () => {
  it("SessionStart prunes state older than 48 hours for every source and keeps newer state", async () => {
    const { root, state } = await setup(["standards-old.txt", "touched-old.txt", "standards-new.txt", "touched-new.txt"]);
    await age(state, "standards-new.txt", ["standards-old.txt", "touched-old.txt"], 49);
    await age(state, "standards-new.txt", ["standards-new.txt", "touched-new.txt"], 1);

    for (const source of ["startup", "resume", "clear", "compact"]) {
      expect((await runClaude(root, JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", source }))).code).toBe(0);
    }

    expect((await readdir(state)).sort()).toEqual(["standards-new.txt", "touched-new.txt"]);
  });

  it("SessionEnd with reason clear forgets only that session", async () => {
    const { root, state } = await setup(["standards-gone.txt", "touched-gone.txt", "standards-other.txt", "touched-other.txt", "standards-gone-agent.txt"]);
    const { code } = await runClaude(root, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "gone", reason: "clear" }));
    expect(code).toBe(0);
    expect((await readdir(state)).sort()).toEqual(["standards-gone-agent.txt", "standards-other.txt", "touched-other.txt"]);
  });

  it("SessionEnd with any other reason deletes nothing", async () => {
    const files = ["standards-keep.txt", "touched-keep.txt"];
    const { root, state } = await setup(files);
    for (const reason of ["prompt_input_exit", "logout", "other", ""]) {
      expect((await runClaude(root, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "keep", reason }))).code).toBe(0);
    }
    expect((await readdir(state)).sort()).toEqual(files);
  });

  it("deletes nothing and exits 0 for malformed input, a missing id, an unknown event, or an id containing a slash", async () => {
    const files = ["standards-keep.txt", "touched-keep.txt"];
    const { root, state } = await setup(files);
    await writeFile(join(root, "kit/standards-x.txt"), "x\n");
    await writeFile(join(root, "kit/touched-x.txt"), "x\n");
    const payloads = [
      "not json at all",
      "",
      JSON.stringify({ hook_event_name: "Stop", session_id: "keep", reason: "clear" }),
      JSON.stringify({ hook_event_name: "SessionEnd", reason: "clear" }),
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "", reason: "clear" }),
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "../x", reason: "clear" }),
    ];
    for (const p of payloads) expect((await runClaude(root, p)).code).toBe(0);
    expect((await readdir(state)).sort()).toEqual(files);
    expect(await exists(join(root, "kit/standards-x.txt"))).toBe(true);
    expect(await exists(join(root, "kit/touched-x.txt"))).toBe(true);
  });

  it("exits 0 when the state directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-cleanup-"));
    roots.push(root);
    expect((await runClaude(root, JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", source: "startup" }))).code).toBe(0);
    expect((await runClaude(root, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", reason: "clear" }))).code).toBe(0);
  });
});
