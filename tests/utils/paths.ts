import { resolve } from "path";

export const ROOT = resolve(import.meta.dir, "../..");

// Skill/hook/agent/command/code-standards CONTENT is authored once and lives here; both
// harness plugins symlink into it rather than duplicating it.
export const SHARED_ROOT = resolve(ROOT, "shared");
export const SKILLS_DIR = resolve(SHARED_ROOT, "skills");
export const HOOKS_DIR = resolve(SHARED_ROOT, "hooks");
export const AGENTS_DIR = resolve(SHARED_ROOT, "agents");
export const COMMANDS_DIR = resolve(SHARED_ROOT, "commands");
export const CODE_STANDARDS_DIR = resolve(SHARED_ROOT, "code-standards");

// Per-harness plugin roots. Each is a real plugin directory (symlinks into shared/ plus
// its own harness-specific real files); tests validating PLUGIN STRUCTURE (manifests,
// symlink wiring, harness-only files) read from these, not from shared/.
export const KIT_CLAUDE_ROOT = resolve(ROOT, "plugins/kit-claude");
export const KIT_CLAUDE_HOOKS_DIR = resolve(KIT_CLAUDE_ROOT, "hooks");
export const KIT_OMP_ROOT = resolve(ROOT, "plugins/kit-omp");
// Stories: content authored once under shared/stories/ (bin, lib, skills, README) and
// symlinked into plugins/stories-claude and plugins/stories-omp.
export const STORIES_ROOT = resolve(SHARED_ROOT, "stories");
export const STORIES_LIB_DIR = resolve(STORIES_ROOT, "lib");
export const STORIES_SKILLS_DIR = resolve(STORIES_ROOT, "skills");
export const STORIES_CLAUDE_ROOT = resolve(ROOT, "plugins/stories-claude");
export const STORIES_OMP_ROOT = resolve(ROOT, "plugins/stories-omp");
export const STORIES_ROOTS: Record<"claude" | "omp", string> = { claude: STORIES_CLAUDE_ROOT, omp: STORIES_OMP_ROOT };

export const MARKETPLACE_DIR = resolve(ROOT, ".claude-plugin");
export const OMP_MARKETPLACE_DIR = resolve(ROOT, ".omp-plugin");

// Writing plugins: opt-in, independent of kit. Their content lives under shared/writing/
// (NOT shared/skills/, whose entries must be linked into both kit plugins).
export const WRITING_ROOT = resolve(SHARED_ROOT, "writing");
export const WRITING_SKILLS_DIR = resolve(WRITING_ROOT, "skills");
export const WRITING_HOOKS_DIR = resolve(WRITING_ROOT, "hooks");
export const WRITING_VALE_DIR = resolve(WRITING_ROOT, "vale");
export const WRITING_CLAUDE_ROOT = resolve(ROOT, "plugins/writing-claude");
export const WRITING_OMP_ROOT = resolve(ROOT, "plugins/writing-omp");
export const WRITING_ROOTS: Record<"claude" | "omp", string> = { claude: WRITING_CLAUDE_ROOT, omp: WRITING_OMP_ROOT };

// Reports: an OMP-only plugin whose extensions and shared lib live entirely inside it.
export const REPORTS_OMP_ROOT = resolve(ROOT, "plugins/reports-omp");
