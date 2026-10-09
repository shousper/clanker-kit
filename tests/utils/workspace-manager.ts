import { mkdtemp, rm, cp, mkdir, readFile, writeFile, realpath, copyFile } from "fs/promises";
import { tmpdir, homedir, userInfo } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const FIXTURES_DIR = resolve(import.meta.dir, "../fixtures");
const WORKSPACE_FIXTURES = join(FIXTURES_DIR, "workspace");
const SESSION_FIXTURES = join(FIXTURES_DIR, "sessions");

export type WorkspaceVariant = "go" | "rust" | "hcl" | "tailwind" | "python" | "cpp" | "stories" | "writing";

export interface WorkspaceOptions {
  session?: "post-brainstorm" | "mid-session" | "brainstorm-design-approved" | "brainstorm-at-transition";
  workspace?: WorkspaceVariant;
}

export interface Workspace {
  cwd: string;
  configDir: string;
  sessionId?: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

/**
 * Parent-session env vars that must be stripped so the child claude process
 * doesn't think it's nested inside another session.
 */
const STRIP_ENV_PREFIXES = ["CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_"];

/**
 * Build an env for spawning a fresh claude process.
 * Strips parent-session nesting guards and sets CLAUDE_CONFIG_DIR for isolation.
 */
function buildEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (STRIP_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  // Explicitly re-set after stripping all CLAUDE_* vars above
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/** Encode a filesystem path the way Claude CLI does: replace non-alphanumeric chars (except -) with -. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Lazy-cached OAuth credentials extracted from macOS Keychain.
 * Extracted once on first call, reused for all subsequent workspaces.
 */
let cachedCredentials: string | undefined;

async function getCredentials(): Promise<string> {
  if (cachedCredentials) return cachedCredentials;

  const proc = Bun.spawn(
    ["security", "find-generic-password", "-a", userInfo().username, "-s", "Claude Code-credentials", "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const raw = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error("Failed to extract credentials from macOS Keychain");

  cachedCredentials = raw.trim();
  return cachedCredentials;
}

/**
 * Install cached OAuth credentials and account metadata into the config dir.
 */
async function installCredentials(configDir: string): Promise<void> {
  const credentials = await getCredentials();
  await writeFile(join(configDir, ".credentials.json"), credentials, { mode: 0o600 });
  try {
    await copyFile(join(homedir(), ".claude.json"), join(configDir, ".claude.json"));
  } catch {
    throw new Error("~/.claude.json not found — is Claude CLI configured?");
  }
}

export async function createWorkspace(options?: WorkspaceOptions): Promise<Workspace> {
  // Resolve symlinks (macOS /var → /private/var) so our encoded cwd
  // matches what the Claude CLI resolves internally.
  const [cwd, configDir] = await Promise.all([
    mkdtemp(join(tmpdir(), "claude-ws-")).then(realpath),
    mkdtemp(join(tmpdir(), "claude-cfg-")).then(realpath),
  ]);

  try {
    // Copy workspace fixtures and install credentials concurrently
    await Promise.all([
      cp(
        options?.workspace
          ? join(FIXTURES_DIR, `workspace-${options.workspace}`)
          : WORKSPACE_FIXTURES,
        cwd,
        { recursive: true },
      ),
      installCredentials(configDir),
    ]);

    // Initialize a git repo so Claude sees a real project
    const gitInit = Bun.spawn(["git", "init"], { cwd, stdout: "ignore", stderr: "ignore" });
    const initCode = await gitInit.exited;
    if (initCode !== 0) throw new Error(`git init failed (exit ${initCode})`);

    const gitAdd = Bun.spawn(["git", "add", "."], { cwd, stdout: "ignore", stderr: "ignore" });
    const addCode = await gitAdd.exited;
    if (addCode !== 0) throw new Error(`git add failed (exit ${addCode})`);

    const gitCommit = Bun.spawn(
      ["git", "commit", "-m", "initial", "--no-gpg-sign"],
      { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" } },
    );
    const commitCode = await gitCommit.exited;
    if (commitCode !== 0) throw new Error(`git commit failed (exit ${commitCode})`);

    let sessionId: string | undefined;
    const projectDir = join(configDir, "projects", encodeCwd(cwd));

    if (options?.session) {
      sessionId = randomUUID();
      await installSession(projectDir, cwd, sessionId, options.session);
    }

    return {
      cwd,
      configDir,
      sessionId,
      env: buildEnv(configDir),
      async cleanup() {
        await Promise.all([
          rm(cwd, { recursive: true, force: true }).catch((e) => console.warn("cleanup failed:", e.message)),
          rm(configDir, { recursive: true, force: true }).catch((e) => console.warn("cleanup failed:", e.message)),
        ]);
      },
    };
  } catch (err) {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }).catch(() => {}),
      rm(configDir, { recursive: true, force: true }).catch(() => {}),
    ]);
    throw err;
  }
}

async function installSession(
  projectDir: string,
  cwd: string,
  sessionId: string,
  fixtureName: string,
): Promise<void> {
  const templatePath = join(SESSION_FIXTURES, `${fixtureName}.jsonl`);
  let content = await readFile(templatePath, "utf-8");

  const escapedCwd = JSON.stringify(cwd).slice(1, -1);
  const escapedSessionId = JSON.stringify(sessionId).slice(1, -1);
  content = content.replaceAll("{{CWD}}", escapedCwd);
  content = content.replaceAll("{{SESSION_ID}}", escapedSessionId);

  const uuidCache = new Map<string, string>();
  content = content.replace(/\{\{UUID_(\d+)\}\}/g, (_, n) => {
    if (!uuidCache.has(n)) uuidCache.set(n, randomUUID());
    return uuidCache.get(n)!;
  });

  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${sessionId}.jsonl`), content);
}
