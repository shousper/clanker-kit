import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runHook, cleanupHookWorkspace } from "../utils/hook-workspace";

afterAll(async () => { await cleanupHookWorkspace(); });
const cfg = () => mkdtemp(join(tmpdir(), "kit-cfg-"));

describe("record.sh", () => {
  it("records a handled file keyed by agent_id, silently", async () => {
    const c = await cfg();
    const r = await runHook("record.sh", {
      tool_name: "Edit", tool_input: { file_path: "/proj/main.go" }, cwd: c,
      session_id: "S", agent_id: "A", env: { CLAUDE_CONFIG_DIR: c },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(await readFile(join(c, "kit/state/touched-A.txt"), "utf-8")).toContain("/proj/main.go");
    await rm(c, { recursive: true, force: true });
  });

  it("ignores unhandled extensions and non-edit tools", async () => {
    const c = await cfg();
    await runHook("record.sh", { tool_name: "Edit", tool_input: { file_path: "/p/readme.md" }, cwd: c, session_id: "S2", env: { CLAUDE_CONFIG_DIR: c } });
    await runHook("record.sh", { tool_name: "Read", tool_input: { file_path: "/p/a.go" }, cwd: c, session_id: "S2", env: { CLAUDE_CONFIG_DIR: c } });
    await expect(readFile(join(c, "kit/state/touched-S2.txt"), "utf-8")).rejects.toThrow();
    await rm(c, { recursive: true, force: true });
  });
});

describe("record.sh: python and c++ sources", () => {
  for (const file of ["/proj/app.py", "/proj/main.cpp"]) {
    it(`records ${file}`, async () => {
      const c = await cfg();
      const r = await runHook("record.sh", {
        tool_name: "Edit", tool_input: { file_path: file }, cwd: c,
        session_id: "S3", env: { CLAUDE_CONFIG_DIR: c },
      });
      expect(r.exitCode).toBe(0);
      expect(await readFile(join(c, "kit/state/touched-S3.txt"), "utf-8")).toContain(file);
      await rm(c, { recursive: true, force: true });
    });
  }
});
