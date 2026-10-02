import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { runNeutralScript } from "../utils/hook-workspace";
import { HOOKS_DIR, KIT_CLAUDE_HOOKS_DIR } from "../utils/paths";

const LIB = resolve(HOOKS_DIR, "lib.sh");

let base: string;     // scratch tree holding everything below
let root: string;     // fake plugin root: code-standards/{go,rust,hcl,tailwindcss}/CLAUDE.md
let alias: string;    // symlink to root
let work: string;     // project dir with an .opentofu-version pin and no Tailwind signal
let stateDir: string; // KIT_STATE_DIR; its parent also receives hcl-tool.json

const LANGS = ["go", "rust", "hcl", "tailwindcss"] as const;
const LABELS: Record<string, string> = {
  go: "Go",
  rust: "Rust",
  hcl: "HCL (Terraform/OpenTofu)",
  tailwindcss: "Tailwind CSS",
};

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "standards-gate-")));
  root = join(base, "plugin");
  for (const lang of LANGS) {
    await mkdir(join(root, "code-standards", lang), { recursive: true });
    await writeFile(join(root, "code-standards", lang, "CLAUDE.md"), `# ${lang} standards\n`);
  }
  alias = join(base, "alias");
  await symlink(root, alias);
  work = join(base, "work");
  await mkdir(work);
  await writeFile(join(work, ".opentofu-version"), "1.8.0\n");
  stateDir = join(base, "state", "kit", "state");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
const freshKey = () => `key-${++counter}`;
const std = (lang: string, pluginRoot = root) => join(pluginRoot, "code-standards", lang, "CLAUDE.md");

function reasonFor(file: string, lang: string, pluginRoot = root, suffix = ""): string {
  const label = LABELS[lang];
  return (
    `kit: before editing ${file}, read the ${label} standards in full at ${std(lang, pluginRoot)} ` +
    `and follow them for all ${label} code in this session, then retry this edit. ` +
    `kit asks once per language per session.${suffix}\n`
  );
}

function gate(sub: "check" | "seen" | "reset", file: string | undefined, key: string, env: Record<string, string> = {}) {
  return runNeutralScript("standards-gate.sh", {
    args: file === undefined ? [sub] : [sub, file],
    cwd: work,
    env: { KIT_PLUGIN_ROOT: root, KIT_STATE_DIR: stateDir, KIT_SCRATCH_KEY: key, ...env },
  });
}

async function expectBlocked(file: string, lang: string, key: string, env: Record<string, string> = {}, suffix = " This project uses tofu.") {
  const r = await gate("check", file, key, env);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toBe(reasonFor(file, lang, env.KIT_PLUGIN_ROOT ?? root, lang === "hcl" ? suffix : ""));
}

async function expectAllowed(file: string, key: string, env: Record<string, string> = {}) {
  const r = await gate("check", file, key, env);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("");
}

describe("kit_physical_path", () => {
  async function physical(path: string): Promise<{ out: string; code: number }> {
    const proc = Bun.spawn(["bash", "-c", `. "${LIB}"; kit_physical_path "$1"`, "_", path], { stdout: "pipe", stderr: "pipe" });
    return { out: await new Response(proc.stdout).text(), code: await proc.exited };
  }

  it("maps a file reached through a symlinked directory and through symlinked files to one path", async () => {
    const dir = join(base, "phys");
    const target = join(dir, "real", "dir", "file.md");
    await mkdir(join(dir, "real", "dir"), { recursive: true });
    await mkdir(join(dir, "real", "nested"), { recursive: true });
    await writeFile(target, "x\n");
    // Decoy: a lexical (non-physical) ".." through linknested/ would land here instead.
    await mkdir(join(dir, "dir"));
    await writeFile(join(dir, "dir", "file.md"), "decoy\n");
    await symlink(join(dir, "real", "dir"), join(dir, "linkdir"));                 // symlinked directory
    await symlink(target, join(dir, "abs-link.md"));                                // absolute file symlink
    await symlink("real/dir/file.md", join(dir, "rel-link.md"));                    // relative file symlink
    await symlink("abs-link.md", join(dir, "chain-link.md"));                       // symlink to a symlink
    await symlink("../dir/file.md", join(dir, "real", "nested", "up-link.md"));     // relative symlink using ..
    await symlink(join(dir, "real", "nested"), join(dir, "linknested"));            // reach up-link.md through a symlinked dir
    for (const p of [
      target,
      join(dir, "linkdir", "file.md"),
      join(dir, "abs-link.md"),
      join(dir, "rel-link.md"),
      join(dir, "chain-link.md"),
      join(dir, "real", "nested", "up-link.md"),
      join(dir, "linknested", "up-link.md"),
      join(dir, "real", "..", "real", "dir", "file.md"),
    ]) {
      const r = await physical(p);
      expect({ p, code: r.code, out: r.out }).toEqual({ p, code: 0, out: target });
    }
  });

  it("resolves a relative symlink given by a relative path", async () => {
    const dir = join(base, "phys");
    const proc = Bun.spawn(["bash", "-c", `. "${LIB}"; cd "${dir}" && kit_physical_path rel-link.md`], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe(join(dir, "real", "dir", "file.md"));
    expect(await proc.exited).toBe(0);
  });

  it("fails with no output for a missing path, a directory, a dangling link, and a link loop", async () => {
    const dir = join(base, "phys-bad");
    await mkdir(join(dir, "adir"), { recursive: true });
    await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    await symlink("loop-b", join(dir, "loop-a"));
    await symlink("loop-a", join(dir, "loop-b"));
    for (const p of [join(dir, "missing"), join(dir, "adir"), join(dir, "dangling"), join(dir, "loop-a"), join(dir, "file.md:1-50"), ""]) {
      const r = await physical(p);
      expect({ p, code: r.code, out: r.out }).toEqual({ p, code: 1, out: "" });
    }
  });
});

describe("standards-gate.sh check", () => {
  it("blocks the first Go edit with the exact reason and allows the retry", async () => {
    const key = freshKey();
    const file = join(work, "main.go");
    const r = await gate("check", file, key);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(
      `kit: before editing ${file}, read the Go standards in full at ${root}/code-standards/go/CLAUDE.md ` +
        `and follow them for all Go code in this session, then retry this edit. kit asks once per language per session.\n`,
    );
    await expectAllowed(file, key);
    await expectAllowed(join(work, "other.go"), key); // state is per language, not per file
  });

  it("gates each language row once, independently", async () => {
    const rows: Array<[string, string]> = [
      ["main.go", "go"], ["go.mod", "go"], ["go.sum", "go"],
      ["lib.rs", "rust"], ["Cargo.toml", "rust"],
      ["main.tf", "hcl"], ["stack.tofu", "hcl"], ["stack.tofu.json", "hcl"], ["prod.tfvars", "hcl"],
    ];
    for (const [name, lang] of rows) {
      const key = freshKey();
      await expectBlocked(join(work, name), lang, key);
      await expectAllowed(join(work, name), key);
    }
    const key = freshKey();
    await expectBlocked(join(work, "main.go"), "go", key);
    await expectBlocked(join(work, "lib.rs"), "rust", key); // a prompted Go does not cover Rust
  });

  it("passes files outside the language table", async () => {
    const key = freshKey();
    for (const name of ["README.md", "script.py", "notes.txt", "data.json", "main.ts", "Makefile", "gofile", "go.work"]) {
      await expectAllowed(join(work, name), key);
    }
    await expectBlocked(join(work, "main.go"), "go", key); // the unknown files recorded nothing
  });

  it("keeps separate state for separate agent keys", async () => {
    const a = freshKey();
    const b = freshKey();
    const file = join(work, "main.rs");
    await expectBlocked(file, "rust", a);
    await expectAllowed(file, a);
    await expectBlocked(file, "rust", b);
  });

  it("does not gate a language whose standards file is missing", async () => {
    const bare = join(base, "bare-plugin");
    await mkdir(join(bare, "code-standards", "rust"), { recursive: true });
    await writeFile(join(bare, "code-standards", "rust", "CLAUDE.md"), "# rust\n");
    const key = freshKey();
    await expectAllowed(join(work, "main.go"), key, { KIT_PLUGIN_ROOT: bare });
    await expectBlocked(join(work, "lib.rs"), "rust", key, { KIT_PLUGIN_ROOT: bare });
    await expectAllowed(join(work, "main.go"), freshKey(), { KIT_PLUGIN_ROOT: join(base, "no-such-root") });
  });

  it("prints the standards path in the form of KIT_PLUGIN_ROOT, not its realpath", async () => {
    const file = join(work, "main.go");
    const r = await gate("check", file, freshKey(), { KIT_PLUGIN_ROOT: alias });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(reasonFor(file, "go", alias));
    expect(r.stdout).toContain(`${alias}/code-standards/go/CLAUDE.md`);
  });

  it("allows the edit when it cannot run or remember its state", async () => {
    const file = join(work, "main.go");
    await expectAllowed(file, "", {});                                  // no agent key
    await expectAllowed(file, freshKey(), { KIT_PLUGIN_ROOT: "" });     // no plugin root
    await expectAllowed("main.go", freshKey());                         // relative path
    await expectAllowed("", freshKey());                                // no path
    expect(existsSync(join(stateDir, "standards-.txt"))).toBe(false);   // empty key wrote nothing

    const notADir = join(base, "not-a-dir");
    await writeFile(notADir, "file\n");
    const unwritable = { KIT_STATE_DIR: join(notADir, "state") };       // mkdir -p cannot succeed
    const key = freshKey();
    await expectAllowed(file, key, unwritable);
    await expectAllowed(file, key, unwritable);                         // never a block that cannot be remembered
  });

  it("reset makes the next edit block again", async () => {
    const key = freshKey();
    const file = join(work, "main.go");
    await expectBlocked(file, "go", key);
    await expectAllowed(file, key);
    const r = await gate("reset", undefined, key);
    expect(r.exitCode).toBe(0);
    await expectBlocked(file, "go", key);
    expect((await gate("reset", undefined, freshKey())).exitCode).toBe(0); // reset with no state is fine
  });

  it("appends the pinned HCL tool, resolving pins in ancestor directories", async () => {
    const tf = join(base, "tf-project");
    const nested = join(tf, "modules", "network");
    await mkdir(nested, { recursive: true });
    await writeFile(join(tf, ".terraform-version"), "1.9.0\n");

    const file = join(nested, "main.tf");
    await expectBlocked(file, "hcl", freshKey(), {}, " This project uses terraform.");
    await expectBlocked(join(work, "main.tf"), "hcl", freshKey(), {}, " This project uses tofu.");
  });

  it("works when invoked through the kit-claude hooks/shared symlink", async () => {
    const file = join(work, "main.tf");
    const r = await runNeutralScript("standards-gate.sh", {
      dir: join(KIT_CLAUDE_HOOKS_DIR, "shared"),
      args: ["check", file],
      cwd: work,
      env: { KIT_PLUGIN_ROOT: root, KIT_STATE_DIR: stateDir, KIT_SCRATCH_KEY: freshKey() },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(reasonFor(file, "hcl", root, " This project uses tofu."));
  });
});

describe("standards-gate.sh seen", () => {
  const goFile = () => join(work, "main.go");

  it("counts a read of the standards file: the next edit passes without a block", async () => {
    const key = freshKey();
    expect((await gate("seen", std("go"), key)).exitCode).toBe(0);
    await expectAllowed(goFile(), key);
    await expectBlocked(join(work, "lib.rs"), "rust", key); // only Go was read
  });

  it("counts a read through a symlinked plugin root, in either direction", async () => {
    const viaAlias = freshKey();
    await gate("seen", std("go", alias), viaAlias);                       // read via alias, plugin root is the real path
    await expectAllowed(goFile(), viaAlias);

    const viaReal = freshKey();
    await gate("seen", std("go"), viaReal, { KIT_PLUGIN_ROOT: alias });   // read via real path, plugin root is the alias
    await expectAllowed(goFile(), viaReal, { KIT_PLUGIN_ROOT: alias });
  });

  it("counts a read through a symlinked directory and through a symlinked CLAUDE.md", async () => {
    await symlink(join(root, "code-standards", "rust"), join(base, "rust-dir-link"));
    await mkdir(join(base, "file-link"));
    await symlink(std("hcl"), join(base, "file-link", "CLAUDE.md"));

    const viaDir = freshKey();
    await gate("seen", join(base, "rust-dir-link", "CLAUDE.md"), viaDir);
    await expectAllowed(join(work, "lib.rs"), viaDir);

    const viaFile = freshKey();
    await gate("seen", join(base, "file-link", "CLAUDE.md"), viaFile);
    await expectAllowed(join(work, "main.tf"), viaFile);
  });

  it("does not count another CLAUDE.md, or the standards of a different language", async () => {
    await writeFile(join(work, "CLAUDE.md"), "# project notes\n");
    await mkdir(join(root, "code-standards", "python"), { recursive: true });
    await writeFile(join(root, "code-standards", "python", "CLAUDE.md"), "# python\n");

    const key = freshKey();
    await gate("seen", join(work, "CLAUDE.md"), key);
    await gate("seen", join(root, "code-standards", "python", "CLAUDE.md"), key);
    await gate("seen", std("rust"), key);
    await expectBlocked(goFile(), "go", key);
  });

  it("does not count a ranged read, but counts a :raw read", async () => {
    const ranged = freshKey();
    for (const suffix of [":1-50", ":50", ":raw:1-50"]) {
      expect((await gate("seen", `${std("go")}${suffix}`, ranged)).exitCode).toBe(0);
    }
    await expectBlocked(goFile(), "go", ranged);

    const raw = freshKey();
    expect((await gate("seen", `${std("go")}:raw`, raw)).exitCode).toBe(0);
    await expectAllowed(goFile(), raw);
  });

  it("ignores paths that do not exist, and never fails", async () => {
    const key = freshKey();
    for (const p of [join(base, "nope", "CLAUDE.md"), "CLAUDE.md", "", join(root, "code-standards")]) {
      expect((await gate("seen", p, key)).exitCode).toBe(0);
    }
    expect((await gate("seen", undefined, key)).exitCode).toBe(0);
    await expectBlocked(goFile(), "go", key);
  });

  it("loses the read when reset runs, so the next edit blocks again", async () => {
    const key = freshKey();
    await gate("seen", std("go"), key);
    await expectAllowed(goFile(), key);
    await gate("reset", undefined, key);
    await expectBlocked(goFile(), "go", key);
  });

  it("keeps a read per agent key", async () => {
    const reader = freshKey();
    const other = freshKey();
    await gate("seen", std("go"), reader);
    await expectAllowed(goFile(), reader);
    await expectBlocked(goFile(), "go", other);
  });
});

describe("standards-gate.sh check: Tailwind CSS", () => {
  const exts = ["css", "tsx", "jsx", "vue", "svelte", "astro", "html"];

  it("gates web files only inside a project with a Tailwind config", async () => {
    for (const cfg of ["js", "cjs", "mjs", "ts"]) {
      const proj = join(base, `tw-config-${cfg}`);
      await mkdir(join(proj, "src", "components"), { recursive: true });
      await writeFile(join(proj, `tailwind.config.${cfg}`), "export default {};\n");
      const key = freshKey();
      await expectBlocked(join(proj, "src", "components", "Button.tsx"), "tailwindcss", key); // config is an ancestor
      await expectAllowed(join(proj, "src", "app.css"), key);
    }
    const proj = join(base, "tw-config-js");
    for (const ext of exts) {
      await expectBlocked(join(proj, `file.${ext}`), "tailwindcss", freshKey());
    }
  });

  it("gates web files inside a project whose package.json depends on tailwindcss", async () => {
    const proj = join(base, "tw-pkg");
    await mkdir(join(proj, "app"), { recursive: true });
    await writeFile(join(proj, "package.json"), JSON.stringify({ devDependencies: { tailwindcss: "^4.0.0" } }));
    await expectBlocked(join(proj, "app", "page.html"), "tailwindcss", freshKey());
  });

  it("passes web files in a project with no Tailwind signal", async () => {
    const plain = join(base, "tw-none");
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    const key = freshKey();
    for (const ext of exts) {
      await expectAllowed(join(plain, `file.${ext}`), key);
      await expectAllowed(join(work, `file.${ext}`), key);
    }
  });

  it("keeps Go, Rust and HCL gating independent of Tailwind signals", async () => {
    const proj = join(base, "tw-config-js");
    await expectBlocked(join(proj, "main.go"), "go", freshKey());
  });
});

describe("standards-gate.sh under /bin/bash", () => {
  const GATE = resolve(HOOKS_DIR, "standards-gate.sh");

  async function runWithSystemBash(args: string[], env: Record<string, string>) {
    const proc = Bun.spawn(["/bin/bash", GATE, ...args], {
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, KIT_PLUGIN_ROOT: root, KIT_STATE_DIR: stateDir, ...env },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  }

  // macOS ships bash 3.2 here; the gate must not use bash 4+ features on the block or seen paths.
  it.skipIf(!existsSync("/bin/bash"))("blocks, records and recognizes a read with the system bash", async () => {
    const key = freshKey();
    const goFile = join(work, "main.go");
    const blocked = await runWithSystemBash(["check", goFile], { KIT_SCRATCH_KEY: key });
    expect(blocked.stderr).toBe("");
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stdout).toBe(reasonFor(goFile, "go"));
    expect((await runWithSystemBash(["check", goFile], { KIT_SCRATCH_KEY: key })).exitCode).toBe(0);

    const readKey = freshKey();
    const seen = await runWithSystemBash(["seen", std("rust", alias)], { KIT_SCRATCH_KEY: readKey });
    expect(seen.stderr).toBe("");
    const afterRead = await runWithSystemBash(["check", join(work, "lib.rs")], { KIT_SCRATCH_KEY: readKey });
    expect({ code: afterRead.exitCode, out: afterRead.stdout }).toEqual({ code: 0, out: "" });
  });
});
