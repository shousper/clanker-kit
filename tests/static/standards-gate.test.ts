import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { runNeutralScript } from "../utils/hook-workspace";
import { HOOKS_DIR, KIT_CLAUDE_HOOKS_DIR } from "../utils/paths";

const LIB = resolve(HOOKS_DIR, "lib.sh");

let base: string;     // scratch tree holding everything below
let root: string;     // fake plugin root: code-standards/scope.md, <lang>/core.md, {rust,python,cpp}/project.md
let alias: string;    // symlink to root
let work: string;     // project dir with an .opentofu-version pin and no Tailwind signal
let stateDir: string; // KIT_STATE_DIR; its parent also receives hcl-tool.json

const LANGS = ["go", "rust", "hcl", "tailwindcss", "python", "cpp"] as const;
const PROJECT_LANGS = ["rust", "python", "cpp"] as const;
const LABELS: Record<string, string> = {
  go: "Go",
  rust: "Rust",
  hcl: "HCL (Terraform/OpenTofu)",
  tailwindcss: "Tailwind CSS",
  python: "Python",
  cpp: "C++",
};

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "standards-gate-")));
  root = join(base, "plugin");
  await mkdir(join(root, "code-standards"), { recursive: true });
  await writeFile(join(root, "code-standards", "scope.md"), "# scope\n");
  for (const lang of LANGS) {
    await mkdir(join(root, "code-standards", lang), { recursive: true });
    await writeFile(join(root, "code-standards", lang, "core.md"), `# ${lang} standards\n`);
  }
  for (const lang of PROJECT_LANGS) {
    await writeFile(join(root, "code-standards", lang, "project.md"), `# ${lang} project\n`);
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
const unitPath = (unit: string, pluginRoot = root) => {
  if (unit === "scope") return join(pluginRoot, "code-standards", "scope.md");
  if (unit.endsWith(":project")) return join(pluginRoot, "code-standards", unit.slice(0, -":project".length), "project.md");
  return join(pluginRoot, "code-standards", unit, "core.md");
};

function reasonFor(file: string, lang: string, units: string[], pluginRoot = root, suffix = ""): string {
  const label = LABELS[lang];
  const paths = units.map((u) => unitPath(u, pluginRoot)).join(", ");
  return (
    `kit: before editing ${file}, read these standards in full and follow them for all ${label} code in this session, ` +
    `then retry this edit: ${paths}. kit asks once per standards file per session.${suffix}\n`
  );
}

function gate(sub: "check" | "seen" | "reset", file: string | undefined, key: string, env: Record<string, string> = {}) {
  return runNeutralScript("standards-gate.sh", {
    args: file === undefined ? [sub] : [sub, file],
    cwd: work,
    env: { KIT_PLUGIN_ROOT: root, KIT_STATE_DIR: stateDir, KIT_SCRATCH_KEY: key, GIT_CEILING_DIRECTORIES: base, ...env },
  });
}

/** Expects a block naming exactly `units` (in order). Defaults to scope plus the language core. */
async function expectBlocked(file: string, lang: string, key: string, env: Record<string, string> = {}, opts: { units?: string[]; suffix?: string } = {}) {
  const r = await gate("check", file, key, env);
  expect(r.exitCode).toBe(2);
  const units = opts.units ?? ["scope", lang];
  expect(r.stdout).toBe(reasonFor(file, lang, units, env.KIT_PLUGIN_ROOT ?? root, lang === "hcl" ? (opts.suffix ?? " This project uses tofu.") : ""));
}

async function expectAllowed(file: string, key: string, env: Record<string, string> = {}) {
  const r = await gate("check", file, key, env);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("");
}

/** Records reads of the given units for `key`. */
async function readUnits(key: string, units: string[], env: Record<string, string> = {}) {
  for (const unit of units) await gate("seen", unitPath(unit, env.KIT_PLUGIN_ROOT ?? root), key, env);
}

function stateOf(key: string): Promise<string> {
  return Bun.file(join(stateDir, `standards-${key}.txt`)).text().catch(() => "");
}

/** Builds a plugin root under `base` with the full layout, minus `omit` files, plus `extra` files (paths relative to code-standards). */
async function makePlugin(name: string, opts: { omit?: string[]; extra?: string[] }): Promise<string> {
  const dir = join(base, name);
  const files = ["scope.md"];
  for (const lang of LANGS) files.push(`${lang}/core.md`);
  for (const lang of PROJECT_LANGS) files.push(`${lang}/project.md`);
  for (const rel of [...files, ...(opts.extra ?? [])]) {
    if ((opts.omit ?? []).includes(rel)) continue;
    await mkdir(dirname(join(dir, "code-standards", rel)), { recursive: true });
    await writeFile(join(dir, "code-standards", rel), `# ${rel}\n`);
  }
  return dir;
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
  it("blocks the first Go edit naming scope then the Go core, and allows the retry", async () => {
    const key = freshKey();
    const file = join(work, "main.go");
    const r = await gate("check", file, key);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(
      `kit: before editing ${file}, read these standards in full and follow them for all Go code in this session, ` +
        `then retry this edit: ${root}/code-standards/scope.md, ${root}/code-standards/go/core.md. ` +
        `kit asks once per standards file per session.\n`,
    );
    await expectAllowed(file, key);
    await expectAllowed(join(work, "other.go"), key); // state is per unit, not per file
  });

  it("gates each language row once, independently", async () => {
    const rows: Array<[string, string, string[]]> = [
      ["main.go", "go", ["scope", "go"]], ["go.mod", "go", ["scope", "go"]], ["go.sum", "go", ["scope", "go"]],
      ["lib.rs", "rust", ["scope", "rust"]], ["Cargo.toml", "rust", ["scope", "rust", "rust:project"]],
      ["main.tf", "hcl", ["scope", "hcl"]], ["stack.tofu", "hcl", ["scope", "hcl"]],
      ["stack.tofu.json", "hcl", ["scope", "hcl"]], ["prod.tfvars", "hcl", ["scope", "hcl"]],
    ];
    for (const [name, lang, units] of rows) {
      const key = freshKey();
      await expectBlocked(join(work, name), lang, key, {}, { units });
      await expectAllowed(join(work, name), key);
    }
    const key = freshKey();
    await expectBlocked(join(work, "main.go"), "go", key);
    // A prompted Go does not cover Rust, but scope was already asked for.
    await expectBlocked(join(work, "lib.rs"), "rust", key, {}, { units: ["rust"] });
  });

  it("passes files outside the language table", async () => {
    const key = freshKey();
    for (const name of ["README.md", "main.c", "requirements.txt", "notes.txt", "data.json", "main.ts", "Makefile", "gofile", "go.work", "util.h", "CMakeLists.txt", ".clang-tidy", ".clang-format"]) {
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

  it("does not gate a language whose core standards file is missing, even when scope exists", async () => {
    const bare = await makePlugin("bare-plugin", { omit: ["go/core.md"] });
    const key = freshKey();
    await expectAllowed(join(work, "main.go"), key, { KIT_PLUGIN_ROOT: bare });
    await expectBlocked(join(work, "lib.rs"), "rust", key, { KIT_PLUGIN_ROOT: bare });
    await expectAllowed(join(work, "main.go"), freshKey(), { KIT_PLUGIN_ROOT: join(base, "no-such-root") });
  });

  it("skips a missing scope file and still gates the language core", async () => {
    const noScope = await makePlugin("no-scope-plugin", { omit: ["scope.md"] });
    await expectBlocked(join(work, "main.go"), "go", freshKey(), { KIT_PLUGIN_ROOT: noScope }, { units: ["go"] });
  });

  it("prints the standards path in the form of KIT_PLUGIN_ROOT, not its realpath", async () => {
    const file = join(work, "main.go");
    const r = await gate("check", file, freshKey(), { KIT_PLUGIN_ROOT: alias });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(reasonFor(file, "go", ["scope", "go"], alias));
    expect(r.stdout).toContain(`${alias}/code-standards/go/core.md`);
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
    await expectBlocked(file, "hcl", freshKey(), {}, { suffix: " This project uses terraform." });
    await expectBlocked(join(work, "main.tf"), "hcl", freshKey(), {}, { suffix: " This project uses tofu." });
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
    expect(r.stdout).toBe(reasonFor(file, "hcl", ["scope", "hcl"], root, " This project uses tofu."));
  });
});

describe("standards-gate.sh check: units", () => {
  it("names only the language core once scope is read", async () => {
    const key = freshKey();
    await readUnits(key, ["scope", "go"]);
    await expectAllowed(join(work, "main.go"), key);
    await expectBlocked(join(work, "lib.rs"), "rust", key, {}, { units: ["rust"] });
  });

  it("asks for scope, core and project on Cargo.toml, then allows every Rust config file", async () => {
    const key = freshKey();
    await expectBlocked(join(work, "Cargo.toml"), "rust", key, {}, { units: ["scope", "rust", "rust:project"] });

    const read = freshKey();
    await readUnits(read, ["scope", "rust", "rust:project"]);
    for (const name of ["Cargo.toml", "clippy.toml", "rust-toolchain.toml", "lib.rs"]) {
      await expectAllowed(join(work, name), read);
    }
  });

  it("names only the project facet when scope and the Rust core are loaded", async () => {
    const key = freshKey();
    await readUnits(key, ["scope", "rust"]);
    await expectBlocked(join(work, "Cargo.toml"), "rust", key, {}, { units: ["rust:project"] });
    await expectAllowed(join(work, "clippy.toml"), key);
  });

  it("treats clippy.toml and rust-toolchain.toml as project config on a first edit", async () => {
    for (const name of ["clippy.toml", "rust-toolchain.toml"]) {
      await expectBlocked(join(work, name), "rust", freshKey(), {}, { units: ["scope", "rust", "rust:project"] });
    }
  });

  it("asks for the project facet on pyproject.toml but not on Python sources", async () => {
    await expectBlocked(join(work, "pyproject.toml"), "python", freshKey(), {}, { units: ["scope", "python", "python:project"] });
    await expectBlocked(join(work, "app.py"), "python", freshKey(), {}, { units: ["scope", "python"] });
  });

  it("includes the C++ project facet on build and tool config in a C++ repository", async () => {
    const repo = join(base, "units-cpp-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "engine.cpp"), "\n");
    for (const name of ["CMakeLists.txt", "foo.cmake", "CMakePresets.json", ".clang-tidy", ".clang-format"]) {
      await expectBlocked(join(repo, name), "cpp", freshKey(), {}, { units: ["scope", "cpp", "cpp:project"] });
    }
    await expectBlocked(join(repo, "engine.h"), "cpp", freshKey(), {}, { units: ["scope", "cpp"] });
  });

  it("passes the shared C and C++ files, including headers, in a pure-C repository", async () => {
    const repo = join(base, "units-c-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "main.c"), "\n");
    const key = freshKey();
    for (const name of ["CMakeLists.txt", "foo.cmake", "CMakePresets.json", ".clang-tidy", ".clang-format", "util.h"]) {
      await expectAllowed(join(repo, name), key);
    }
  });

  it("fails open for a project facet whose file does not exist", async () => {
    const noFacet = await makePlugin("no-rust-project-plugin", { omit: ["rust/project.md"] });
    await expectBlocked(join(work, "Cargo.toml"), "rust", freshKey(), { KIT_PLUGIN_ROOT: noFacet }, { units: ["scope", "rust"] });
  });

  it("finds a new facet file without code changes", async () => {
    const extra = await makePlugin("go-project-plugin", { extra: ["go/project.md"] });
    const key = freshKey();
    await gate("seen", unitPath("go:project", extra), key, { KIT_PLUGIN_ROOT: extra });
    expect(await stateOf(key)).toContain("go:project loaded");
  });

  it("does not mark a unit for the core of another plugin root or an unrelated core.md", async () => {
    const other = await makePlugin("other-plugin", {});
    await mkdir(join(work, "pkg"), { recursive: true });
    await writeFile(join(work, "pkg", "core.md"), "# unrelated\n");
    const key = freshKey();
    await gate("seen", unitPath("go", other), key);
    await gate("seen", unitPath("scope", other), key);
    await gate("seen", join(work, "pkg", "core.md"), key);
    expect(await stateOf(key)).toBe("");
    await expectBlocked(join(work, "main.go"), "go", key);
  });
});

describe("standards-gate.sh check: C++ repository scan cache", () => {
  it("scans a repository root once per agent", async () => {
    const repo = join(base, "cache-c-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "main.c"), "\n");
    const header = join(repo, "util.h");

    const key = freshKey();
    await expectAllowed(header, key);
    expect(await stateOf(key)).toContain(`cpp-root no ${repo}\n`);

    await writeFile(join(repo, "engine.cpp"), "\n");
    await expectAllowed(header, key); // cached answer for this agent

    const other = freshKey();
    await expectBlocked(header, "cpp", other); // a different agent scans again
  });

  it("keeps the cache lines apart from unit state and from roots with spaces", async () => {
    const repo = join(base, "cache spaced repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "engine.cpp"), "\n");
    const key = freshKey();
    await expectBlocked(join(repo, "util.h"), "cpp", key);
    expect(await stateOf(key)).toContain(`cpp-root yes ${repo}\n`);
    await readUnits(key, ["scope", "cpp"]);
    await expectAllowed(join(repo, "util.h"), key);
  });

  it("caches a root containing a backslash once", async () => {
    const repo = join(base, "repos", "back\\tslash");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "util.h"), "\n");
    const key = freshKey();
    for (let i = 0; i < 3; i++) await expectAllowed(join(repo, "util.h"), key);
    const lines = (await stateOf(key)).split("\n").filter((l) => l.startsWith("cpp-root "));
    expect(lines).toEqual([`cpp-root no ${repo}`]);
  });
});

describe("standards-gate.sh seen", () => {
  const goFile = () => join(work, "main.go");

  it("counts a read of the standards files: the next edit passes without a block", async () => {
    const key = freshKey();
    expect((await gate("seen", unitPath("scope"), key)).exitCode).toBe(0);
    expect((await gate("seen", unitPath("go"), key)).exitCode).toBe(0);
    await expectAllowed(goFile(), key);
    await expectBlocked(join(work, "lib.rs"), "rust", key, {}, { units: ["rust"] }); // only scope and Go were read
  });

  it("counts a read through a symlinked plugin root, in either direction", async () => {
    const viaAlias = freshKey();
    await gate("seen", unitPath("scope", alias), viaAlias);                // read via alias, plugin root is the real path
    await gate("seen", unitPath("go", alias), viaAlias);
    await expectAllowed(goFile(), viaAlias);

    const viaReal = freshKey();
    const env = { KIT_PLUGIN_ROOT: alias };
    await gate("seen", unitPath("scope"), viaReal, env);                   // read via real path, plugin root is the alias
    await gate("seen", unitPath("go"), viaReal, env);
    await expectAllowed(goFile(), viaReal, env);
  });

  it("counts a read through a symlinked directory and through a symlinked core.md", async () => {
    await symlink(join(root, "code-standards", "rust"), join(base, "rust-dir-link"));
    await mkdir(join(base, "file-link"));
    await symlink(unitPath("hcl"), join(base, "file-link", "core.md"));

    const viaDir = freshKey();
    await gate("seen", unitPath("scope"), viaDir);
    await gate("seen", join(base, "rust-dir-link", "core.md"), viaDir);
    await expectAllowed(join(work, "lib.rs"), viaDir);

    const viaFile = freshKey();
    await gate("seen", unitPath("scope"), viaFile);
    await gate("seen", join(base, "file-link", "core.md"), viaFile);
    await expectAllowed(join(work, "main.tf"), viaFile);
  });

  it("does not count another CLAUDE.md or core.md, or the standards of a different language", async () => {
    await writeFile(join(work, "CLAUDE.md"), "# project notes\n");

    const key = freshKey();
    await gate("seen", unitPath("scope"), key);
    await gate("seen", join(work, "CLAUDE.md"), key);
    await gate("seen", unitPath("python"), key);
    await gate("seen", unitPath("rust"), key);
    await expectBlocked(goFile(), "go", key, {}, { units: ["go"] });
  });

  it("does not count a ranged read, but counts a :raw read", async () => {
    const ranged = freshKey();
    for (const suffix of [":1-50", ":50", ":raw:1-50"]) {
      expect((await gate("seen", `${unitPath("go")}${suffix}`, ranged)).exitCode).toBe(0);
      expect((await gate("seen", `${unitPath("scope")}${suffix}`, ranged)).exitCode).toBe(0);
    }
    await expectBlocked(goFile(), "go", ranged);

    const raw = freshKey();
    await gate("seen", `${unitPath("scope")}:raw`, raw);
    expect((await gate("seen", `${unitPath("go")}:raw`, raw)).exitCode).toBe(0);
    await expectAllowed(goFile(), raw);
  });

  it("ignores paths that do not exist, and never fails", async () => {
    const key = freshKey();
    for (const p of [join(base, "nope", "core.md"), "core.md", "scope.md", "", join(root, "code-standards")]) {
      expect((await gate("seen", p, key)).exitCode).toBe(0);
    }
    expect((await gate("seen", undefined, key)).exitCode).toBe(0);
    await expectBlocked(goFile(), "go", key);
  });

  it("loses the read when reset runs, so the next edit blocks again", async () => {
    const key = freshKey();
    await readUnits(key, ["scope", "go"]);
    await expectAllowed(goFile(), key);
    await gate("reset", undefined, key);
    await expectBlocked(goFile(), "go", key);
  });

  it("keeps a read per agent key", async () => {
    const reader = freshKey();
    const other = freshKey();
    await readUnits(reader, ["scope", "go"]);
    await expectAllowed(goFile(), reader);
    await expectBlocked(goFile(), "go", other);
  });
});

describe("standards-gate.sh check: Python", () => {
  /** Python sources, stubs and the project file each block the first edit and name the Python standards. */
  it("gates .py, .pyi and pyproject.toml once per agent", async () => {
    const rows: Array<[string, string[]]> = [
      ["app.py", ["scope", "python"]],
      ["types.pyi", ["scope", "python"]],
      ["pyproject.toml", ["scope", "python", "python:project"]],
    ];
    for (const [name, units] of rows) {
      const key = freshKey();
      const file = join(work, name);
      const blocked = await gate("check", file, key);
      expect(blocked.exitCode, `${name} must block the first Python edit`).toBe(2);
      expect(blocked.stdout, `${name} must name the Python standards`).toBe(reasonFor(file, "python", units));
      const retried = await gate("check", file, key);
      expect(retried.exitCode, `${name} must pass on the retry`).toBe(0);
    }
  });

  /** A full read of the Python standards satisfies the gate, and an agent with no read is still blocked. */
  it("allows the first Python edit only after a full read of the Python standards", async () => {
    const reader = freshKey();
    await readUnits(reader, ["scope", "python"]);
    const afterRead = await gate("check", join(work, "app.py"), reader);
    expect(afterRead.exitCode, "a read of the Python standards must satisfy the gate").toBe(0);
    const withoutRead = await gate("check", join(work, "app.py"), freshKey());
    expect(withoutRead.exitCode, "an agent that has not read the Python standards must be blocked").toBe(2);
  });
});

describe("standards-gate.sh check: C++", () => {
  const cppOnlyNames = [
    "engine.cpp", "engine.cc", "engine.cxx", "engine.hpp", "engine.hh",
    "engine.hxx", "engine.ipp", "engine.tpp", "engine.inl",
  ];

  /** Each C++-only extension blocks the first edit and names the C++ standards, in any directory. */
  it("gates C++-only sources and headers once per agent", async () => {
    for (const name of cppOnlyNames) {
      const key = freshKey();
      const file = join(work, name);
      const blocked = await gate("check", file, key);
      expect(blocked.exitCode, `${name} must block the first C++ edit`).toBe(2);
      expect(blocked.stdout, `${name} must name the C++ standards`).toBe(reasonFor(file, "cpp", ["scope", "cpp"]));
      const retried = await gate("check", file, key);
      expect(retried.exitCode, `${name} must pass on the retry`).toBe(0);
    }
  });

  /** A full read of the C++ standards satisfies the gate, and an agent with no read is still blocked. */
  it("allows the first C++ edit only after a full read of the C++ standards", async () => {
    const reader = freshKey();
    await readUnits(reader, ["scope", "cpp"]);
    const afterRead = await gate("check", join(work, "engine.cpp"), reader);
    expect(afterRead.exitCode, "a read of the C++ standards must satisfy the gate").toBe(0);
    const withoutRead = await gate("check", join(work, "engine.cpp"), freshKey());
    expect(withoutRead.exitCode, "an agent that has not read the C++ standards must be blocked").toBe(2);
  });

  const sharedNames = ["include/project_name/engine.h", "CMakeLists.txt", "cmake/warnings.cmake", "CMakePresets.json"];
  const cppUnitsFor = (relative: string) => (relative.endsWith(".h") ? ["scope", "cpp"] : ["scope", "cpp", "cpp:project"]);

  /** In a repository that holds a C++ source, every shared C and C++ file blocks as C++. A .git file marks a worktree. */
  it("gates .h and CMake files as C++ in a repository with C++ sources", async () => {
    const repo = join(base, "cpp-repo");
    await mkdir(join(repo, "src", "engine"), { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/cpp-repo\n");
    await writeFile(join(repo, "src", "engine", "engine.cpp"), "int main() { return 0; }\n");
    for (const relative of sharedNames) {
      const file = join(repo, relative);
      const blocked = await gate("check", file, freshKey());
      expect(blocked.exitCode, `${relative} must block in a C++ repository`).toBe(2);
      expect(blocked.stdout, `${relative} must name the C++ standards`).toBe(reasonFor(file, "cpp", cppUnitsFor(relative)));
    }
  });

  /** In a repository with only C sources, every shared file passes, so C code never gets C++ rules. */
  it("passes .h and CMake files in a repository with only C sources", async () => {
    const repo = join(base, "c-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "main.c"), "int main(void) { return 0; }\n");
    const key = freshKey();
    for (const relative of sharedNames) {
      const result = await gate("check", join(repo, relative), key);
      expect(result.exitCode, `${relative} must pass in a C repository`).toBe(0);
      expect(result.stdout, `${relative} must print no block reason in a C repository`).toBe("");
    }
  });

  /** C++ sources under vendored, generated or dependency directories do not make a C repository count as C++. */
  it("ignores C++ sources under vendored and build directories", async () => {
    const repo = join(base, "c-repo-vendored");
    await mkdir(join(repo, ".git"), { recursive: true });
    for (const skipped of ["third_party/json", "vendor/fmt", "build/generated", "cmake-build-debug/gen", "node_modules/addon"]) {
      await mkdir(join(repo, skipped), { recursive: true });
      await writeFile(join(repo, skipped, "skipped.cpp"), "\n");
    }
    const result = await gate("check", join(repo, "util.h"), freshKey());
    expect(result.exitCode, "vendored and build C++ sources must not gate a C header").toBe(0);
  });

  /** Outside a repository, the search covers only the directory of the edited file. */
  it("searches only the directory of the file when there is no repository", async () => {
    const loose = join(base, "loose-headers");
    await mkdir(join(loose, "with-cpp"), { recursive: true });
    await mkdir(join(loose, "without-cpp"), { recursive: true });
    await writeFile(join(loose, "with-cpp", "engine.cpp"), "\n");
    const withCpp = await gate("check", join(loose, "with-cpp", "engine.h"), freshKey());
    expect(withCpp.exitCode, "a header next to a C++ source must block").toBe(2);
    const withoutCpp = await gate("check", join(loose, "without-cpp", "util.h"), freshKey());
    expect(withoutCpp.exitCode, "a header with no C++ source in its directory must pass").toBe(0);
  });

  /** The repository search never climbs into a GIT_CEILING_DIRECTORIES entry, as git does. */
  it("stops the repository search at GIT_CEILING_DIRECTORIES", async () => {
    const outer = join(base, "ceiling-outer");
    const inner = join(outer, "inner");
    await mkdir(join(outer, ".git"), { recursive: true });
    await mkdir(join(inner, "headers"), { recursive: true });
    await writeFile(join(outer, "engine.cpp"), "\n");
    const header = join(inner, "headers", "util.h");
    const stopped = await gate("check", header, freshKey(), { GIT_CEILING_DIRECTORIES: inner });
    expect(stopped.exitCode, "the search must not reach the C++ source above the ceiling").toBe(0);
    const climbed = await gate("check", header, freshKey());
    expect(climbed.exitCode, "below the default ceiling, the search must find the repository and its C++ source").toBe(2);
  });

  /** C++ state from another repository must not turn a pure C repository's build files into C++ units. */
  it("passes a C repository's CMakeLists.txt after the agent has worked in a C++ repository", async () => {
    const cRepo = join(base, "cproj");
    const cppRepo = join(base, "cppproj");
    await mkdir(join(cRepo, ".git"), { recursive: true });
    await mkdir(join(cppRepo, ".git"), { recursive: true });
    await mkdir(join(cppRepo, "src"), { recursive: true });
    await writeFile(join(cRepo, "main.c"), "\n");
    await writeFile(join(cppRepo, "src", "engine.cpp"), "\n");
    const key = freshKey();
    await expectAllowed(join(cRepo, "CMakeLists.txt"), key);
    await expectBlocked(join(cppRepo, "src", "engine.cpp"), "cpp", key);
    await readUnits(key, ["scope", "cpp"]);
    await expectAllowed(join(cRepo, "CMakeLists.txt"), key);
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
    expect(blocked.stdout).toBe(reasonFor(goFile, "go", ["scope", "go"]));
    expect((await runWithSystemBash(["check", goFile], { KIT_SCRATCH_KEY: key })).exitCode).toBe(0);

    const readKey = freshKey();
    for (const unit of ["scope", "rust"]) {
      const seen = await runWithSystemBash(["seen", unitPath(unit, alias)], { KIT_SCRATCH_KEY: readKey });
      expect(seen.stderr).toBe("");
    }
    const afterRead = await runWithSystemBash(["check", join(work, "lib.rs")], { KIT_SCRATCH_KEY: readKey });
    expect({ code: afterRead.exitCode, out: afterRead.stdout }).toEqual({ code: 0, out: "" });
  });
});
