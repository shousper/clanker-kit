import { readFile } from "fs/promises";
import { join } from "path";
import type { WorkspaceVariant } from "../utils/workspace-manager";
import type { StandardsLang } from "../utils/standards-trace";

/**
 * One live-eval scenario per gated language. `prompt` forces a real edit of `target`
 * through an edit tool; `landed` reads the workspace afterwards and says whether the edit
 * happened, and is false on the pristine fixture so a case cannot pass vacuously.
 */
export interface StandardsCase {
  lang: StandardsLang;
  workspace: WorkspaceVariant;
  /** Edited file, relative to the workspace root. */
  target: string;
  prompt: string;
  landed(cwd: string): Promise<boolean>;
}

const NO_SHELL = "Make the change with your file-editing tools, not shell commands, and do not run the project.";

const read = (cwd: string, rel: string): Promise<string> => readFile(join(cwd, rel), "utf-8");

export const STANDARDS_CASES: StandardsCase[] = [
  {
    lang: "go",
    workspace: "go",
    target: "cmd/server/main.go",
    prompt: `In cmd/server/main.go, add a /version handler that responds with the text v1.2.3 and register it next to /health. ${NO_SHELL}`,
    landed: async (cwd) => (await read(cwd, "cmd/server/main.go")).includes("v1.2.3"),
  },
  {
    lang: "rust",
    workspace: "rust",
    target: "src/main.rs",
    prompt: `In src/main.rs, replace the two unwrap() calls in read_config with expect() calls whose messages are "CONFIG_PATH must be set" and "config file must be readable". ${NO_SHELL}`,
    landed: async (cwd) => (await read(cwd, "src/main.rs")).includes("CONFIG_PATH must be set"),
  },
  {
    lang: "hcl",
    workspace: "hcl",
    target: "variables.tf",
    prompt: `Add a variable named environment, type string, default "dev", to variables.tf. ${NO_SHELL}`,
    landed: async (cwd) => /variable\s+"environment"/.test(await read(cwd, "variables.tf")),
  },
  {
    lang: "tailwindcss",
    workspace: "tailwind",
    target: "src/App.tsx",
    prompt: `In src/App.tsx, replace the inline style props with Tailwind utility classes in className. ${NO_SHELL}`,
    landed: async (cwd) => {
      const src = await read(cwd, "src/App.tsx");
      return src.includes("className=") && !src.includes("style={{");
    },
  },
  {
    lang: "python",
    workspace: "python",
    target: "src/inventory/stock.py",
    prompt: `In src/inventory/stock.py, add a function named needs_restock that takes units_on_hand and reorder_level as ints and returns True when units_on_hand is below reorder_level. ${NO_SHELL}`,
    landed: async (cwd) => /def needs_restock\(/.test(await read(cwd, "src/inventory/stock.py")),
  },
  {
    lang: "cpp",
    workspace: "cpp",
    target: "src/main.cpp",
    prompt: `In src/main.cpp, make the program print v1.2.3 and exit when its only argument is --version. ${NO_SHELL}`,
    landed: async (cwd) => (await read(cwd, "src/main.cpp")).includes("v1.2.3"),
  },
];
