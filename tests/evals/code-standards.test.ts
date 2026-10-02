import { describe, it } from "bun:test";
import { join } from "path";
import { runEval } from "../utils/eval-runner";
import { runTrials, type TrialResult } from "../utils/trials";
import { createWorkspace } from "../utils/workspace-manager";
import { selectHarnesses, type Harness, type NormalizedEvent } from "../utils/harness";
import {
  analyseStandards,
  delegationViolations,
  readGateStates,
  renderTrace,
  standardsViolations,
  topLevelSessionId,
} from "../utils/standards-trace";
import { STANDARDS_CASES, type StandardsCase } from "../fixtures/standards-cases";

// The gate is deterministic, so every trial must pass: a single miss is a gate defect or
// a harness event it does not see, not sampling noise. Two trials per case keep the
// matrix cheap while still catching an agent that only sometimes reads after a block.
const TRIALS = Number(process.env.STANDARDS_TRIALS ?? 2);
const PER_TRIAL_TIMEOUT = 120_000;
const MAX_TURNS = 15;
const SKIP_CLEANUP = process.env.SKIP_CLEANUP === "1";
const RUN_EVALS = process.env.RUN_EVALS === "1";

interface TrialReport extends TrialResult {
  violations: string[];
  trace: string;
  exitCode: number;
  stderr: string;
}

/**
 * Runs one agent session in a fresh fixture workspace with permissions bypassed (a hook
 * block must hold anyway) and the gate's state redirected into the workspace's throwaway
 * config dir. The Claude wrappers derive state from CLAUDE_CONFIG_DIR, which
 * createWorkspace already isolates and which resolves to the same directory; OMP's
 * extension reads KIT_STATE_DIR from the process env, so it is set explicitly.
 */
async function runTrial(
  harness: Harness,
  c: StandardsCase,
  prompt: string,
  judge: (ctx: { events: NormalizedEvent[]; stdout: string; stateDir: string }) => Promise<string[]>,
): Promise<TrialReport> {
  const ws = await createWorkspace({ workspace: c.workspace });
  const stateDir = join(ws.configDir, "kit", "state");
  try {
    const result = await runEval(harness, prompt, {
      timeout: PER_TRIAL_TIMEOUT,
      maxTurns: MAX_TURNS,
      cwd: ws.cwd,
      env: { ...ws.env, KIT_STATE_DIR: stateDir },
      pluginDirs: [harness.pluginRoot],
      ephemeral: true,
      dangerouslySkipPermissions: true,
    });
    const violations: string[] = [];
    if (result.exitCode === 124) violations.push("the run timed out");
    if (result.events.some((e) => e.kind === "error")) violations.push("the harness reported an error event");
    violations.push(...(await judge({ events: result.events, stdout: result.stdout, stateDir })));
    if (!(await c.landed(ws.cwd))) violations.push(`the edit to ${c.target} did not land`);
    return {
      pass: violations.length === 0,
      invalid: result.events.some((e) => e.kind === "fallback"),
      violations,
      trace: renderTrace(result.events),
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  } finally {
    if (!SKIP_CLEANUP) await ws.cleanup();
  }
}

function failure(label: string, harness: Harness, c: StandardsCase, reports: TrialReport[], invalid: boolean): Error {
  const body = reports
    .map(
      (r, i) =>
        `  Trial ${i + 1} [${r.pass ? "PASS" : "FAIL"}] (exit ${r.exitCode})\n` +
        r.violations.map((v) => `    - ${v}`).join("\n") +
        `\n  tool calls:\n${r.trace}` +
        (r.stderr ? `\n  stderr: ${r.stderr.slice(0, 200)}` : ""),
    )
    .join("\n");
  return new Error(
    `${invalid ? "[INVALID RUN] model fallback; " : ""}${label} failed on ${harness.id}/${c.lang} (every trial must pass)\n${body}`,
  );
}

function runStandardsSuite(harness: Harness) {
  describe.skipIf(!RUN_EVALS)(`standards gate (${harness.id})`, () => {
    for (const c of STANDARDS_CASES) {
      it(
        `${c.lang}: reads the standards once, before the first edit, blocked at most once`,
        async () => {
          const reports: TrialReport[] = [];
          const outcome = await runTrials({
            trials: TRIALS,
            requiredPasses: TRIALS,
            run: async () => {
              const report = await runTrial(harness, c, c.prompt, async ({ events }) =>
                standardsViolations(analyseStandards(harness, events, c.lang), c.lang),
              );
              reports.push(report);
              return report;
            },
          });
          if (!outcome.passed) throw failure("standards gate", harness, c, reports, outcome.invalid);
        },
        TRIALS * PER_TRIAL_TIMEOUT * harness.timeoutScale + 60_000,
      );
    }

    // Delegation runs on Go only: the language table is already covered above, and what
    // is new here is the agent key.
    const go = STANDARDS_CASES.find((c) => c.lang === "go")!;
    it(
      "go: a subagent that makes the edit reads the standards under its own key",
      async () => {
        const prompt =
          "Delegate this change: use your subagent tool (the task or Agent tool) to spawn exactly one subagent to make it, " +
          "and do not read or edit any file yourself. When the subagent finishes, reply DONE.\n\nThe change: " +
          go.prompt;
        const reports: TrialReport[] = [];
        const outcome = await runTrials({
          trials: TRIALS,
          requiredPasses: TRIALS,
          run: async () => {
            const report = await runTrial(harness, go, prompt, async ({ stdout, stateDir }) =>
              delegationViolations(await readGateStates(stateDir), topLevelSessionId(harness, stdout), "go"),
            );
            reports.push(report);
            return report;
          },
        });
        if (!outcome.passed) throw failure("subagent standards gate", harness, go, reports, outcome.invalid);
      },
      TRIALS * PER_TRIAL_TIMEOUT * harness.timeoutScale + 60_000,
    );
  });
}

for (const harness of selectHarnesses(process.env.HARNESSES)) {
  runStandardsSuite(harness);
}
