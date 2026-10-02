import type { WorkspaceVariant } from "../utils/workspace-manager";

export type SessionContext = "cold-start" | "post-brainstorm" | "mid-session";

export interface ActivationTest {
  skill: string;
  prompt: string;
  shouldActivate: boolean;
  sessionContext?: SessionContext;
  workspace?: WorkspaceVariant;
}

type PromptEntry = string | {
  prompt: string;
  session?: SessionContext;
  workspace?: WorkspaceVariant;
};

type SkillPrompts = {
  activate: PromptEntry[];
  skip: PromptEntry[];
};

function flatten(prompts: Record<string, SkillPrompts>): ActivationTest[] {
  const tests: ActivationTest[] = [];
  for (const [skill, { activate, skip }] of Object.entries(prompts)) {
    for (const entry of activate) {
      const e = typeof entry === "string" ? { prompt: entry } : entry;
      tests.push({
        skill,
        prompt: e.prompt,
        shouldActivate: true,
        ...(e.session ? { sessionContext: e.session } : {}),
        ...(e.workspace ? { workspace: e.workspace } : {}),
      });
    }
    for (const entry of skip) {
      const e = typeof entry === "string" ? { prompt: entry } : entry;
      tests.push({
        skill,
        prompt: e.prompt,
        shouldActivate: false,
        ...(e.session ? { sessionContext: e.session } : {}),
        ...(e.workspace ? { workspace: e.workspace } : {}),
      });
    }
  }
  return tests;
}

const prompts: Record<string, SkillPrompts> = {
  "brainstorming": {
    activate: [
      "Let's build a new feature for user notifications",
      "I want to add support for exposing a new admin API endpoint, including security considerations and rate limiting strategy",
      "We need to refactor the data pipeline to handle distributed tables instead of single-node. What's the best approach?",
    ],
    skip: [
      "Fix the bug in the auth gateway where bcrypt hashing is slow",
      "Can you update the README to mention the new rate limiting feature?",
      "What files are in the project root?",
      "Analyze our auth system architecture using ARCHITECTURE.md and the codebase to identify what improvements we should prioritize next",
      "I'm disappointed with how this diagram turned out, should we iterate more on the approach or try something completely different?",
    ],
  },

  "code-review": {
    activate: [
      "Let's have a code reviewer look at these changes. They should compare the current implementation against the design spec and flag any gaps or technical issues.",
      "Can you review the implementation in `/src/auth/login.ts` against the design spec for correctness and architectural alignment?",
      "I've implemented the payment feature. Have a reviewer look at the changes against origin/main and spot any problems before we merge.",
      "We should get a code review on the database layer before integrating this with the API.",
      { prompt: "Can you review what I've implemented so far?", session: "mid-session" },
    ],
    skip: [
      "Please review the documentation standards document to ensure the new CLAUDE.md section fits naturally.",
      "Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant. Summarize what happened in 2-4 sentences.",
    ],
  },

  "writing:writing-docs": {
    activate: [
      { prompt: "Write a README for this package that explains installation and basic usage", workspace: "writing" },
      { prompt: "Add documentation comments to the exported functions in src/store.ts", workspace: "writing" },
      { prompt: "Document the release procedure in docs/releasing.md: bump the version, tag, and publish", workspace: "writing" },
    ],
    skip: [
      { prompt: "Write the commit message for the staged changes", workspace: "writing" },
      { prompt: "Fix the flaky test in tests/store.test.ts", workspace: "writing" },
      "Explain what a git worktree is",
    ],
  },

  "create-pr": {
    activate: [
      "Let's create a pull request for this feature branch as a draft so I can review it on GitHub first",
      "Create a PR for this branch and mark it ready for review immediately",
      "I've committed and pushed the changes. Now let's create a pull request for this branch",
    ],
    skip: [
      "I need to add a new feature to handle user authentication. Start by creating the function and writing tests",
      "Write a comprehensive README for the deployment system, covering architecture, contracts, transforms, and Helm charts",
      "I think this code is ready now. Let's merge it",
    ],
  },

  "debugging": {
    activate: [
      "I'm getting an unexpected error in the auth module, tests are failing",
      "I ran the tests and got 3 failures. The error messages mention a type mismatch in the auth service, but I'm not sure what changed. I tried changing the type signature but that just created more errors.",
      "The API endpoint returns 500 sometimes but not always. No pattern to when it fails.",
      "After deploying the new config, the webhook service can't reach the database. Connection timeout. Did a quick restart but still broken.",
      "Got this error three times when deploying: 'address already in use'. Sometimes the deployment succeeds anyway.",
      { prompt: "The auth middleware tests are failing after my last change", session: "mid-session" },
    ],
    skip: [
      "Can you refactor the error handling in the auth module to be more consistent?",
      "I'm adding a new feature for two-factor authentication. How should I structure the validation?",
      "Should we be using JWT or OAuth for this module?",
    ],
  },

  "finish-branch": {
    activate: [
      "All tests pass, implementation is done, let's wrap up this branch",
      "Implementation complete. Time to finish this branch.",
      "Tests pass, let's wrap up this work and merge it.",
      "We're done with this branch. Everything's implemented and passing, let's finalize it.",
      "This branch is finished. Wrap it up and get it ready for merge.",
    ],
    skip: [
      "Can you verify all tests pass before we continue?",
      "I've started the implementation. What should I test next?",
      "Let me plan out the implementation before we start coding.",
    ],
  },

  "git-worktrees": {
    activate: [
      "I need to start work on a new feature in isolation",
      "I'm working on a new feature that needs isolation. Set up a git worktree for me.",
      "Can you establish a git worktree on a branch for this work?",
      "The design is approved. Please create a worktree and set up an isolated workspace for implementation.",
      { prompt: "Design is approved. Set up a worktree for implementation.", session: "post-brainstorm" },
    ],
    skip: [
      "We are working in the alerting worktree now. Can you investigate why the deployment is timing out?",
      "Skip the worktree. I've already created a branch. Just proceed with the work.",
      "This session is being continued from a previous conversation. The user was working on a feature in a git worktree.",
    ],
  },

  "github-work-summary": {
    activate: [
      "What did I work on this week? Give me a summary for standup",
      "What did I do last week? I need notes for my standup meeting.",
      "Summarize my GitHub contributions from last Monday to Friday. Focus on what I personally contributed.",
      "Show me a work summary for the org for last month. I need this for my performance review.",
    ],
    skip: [
      "Please write a concise summary of this conversation. Output ONLY the summary - no preamble. Summarize what happened in 2-4 sentences.",
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
      "What have I done wrong here? What's broken? git commit error: gpg failed to sign the data",
    ],
  },

  "parallel-agents": {
    activate: [
      "I have 3 independent refactoring tasks — run them in parallel",
      "Dispatch parallel agents: auth subsystem, batch processing, and abort logic each need independent investigation",
    ],
    skip: [
      "I have a complex system to understand. Can you break it into 5 investigation areas and have agents explore each?",
      "Update these 4 services to use the new API. Start with the auth service, then database, then messaging, then cache.",
      "We need to audit the entire codebase for security issues. Can you dispatch multiple agents to different components?",
    ],
  },

  "receiving-review": {
    activate: [
      "I got code review feedback on my PR, let me address it",
      "I got code review feedback. There are 6 items: items 1-3 I understand, but 4-6 are unclear. Should I implement 1-3 while asking about 4-6?",
      "Reviewer wants me to remove this legacy code, but we still support users on older OS versions that need it. How should I respond?",
      "An external reviewer on GitHub suggested a complete refactor of the auth module. I think they don't understand our constraints. Should I just implement it?",
    ],
    skip: [
      "I reviewed the feedback carefully. It's all correct. Should I start implementing?",
      "How do I ask for code review on my PR?",
      "Thanks for the great feedback! I'm going to start implementing all of it right now.",
    ],
  },

  "tdd": {
    activate: [
      "Write a test for email validation, then implement the function to pass that test using test-driven development",
      "Write a function to validate email addresses using TDD",
      "Build a retry mechanism that retries operations up to 3 times. Use test-first development.",
      "Fix the bug where empty emails are accepted. Write a failing test first that reproduces it.",
      "Refactor the authentication module - write a failing test first that captures the refactoring intent, then refactor while keeping tests green",
      { prompt: "Let's implement the token refresh endpoint next using TDD — write the test first", session: "mid-session" },
    ],
    skip: [
      "I already wrote this function, can you review it?",
      "Add tests to this existing code",
      "Help me design a system architecture",
    ],
  },

  "build-flow": {
    activate: [
      "I have an implementation plan ready, let's execute it",
      "I've finalized the implementation plan. Now let's build it.",
      "I have a written plan at docs/plans/2026-02-20-auth-system.md — please execute it",
      { prompt: "Let's execute this plan", session: "post-brainstorm" },
    ],
    skip: [
      "I'm continuing from the previous session where we brainstormed the approach",
      "I have a plan doc I wrote; can you review it?",
      "Let's brainstorm ideas for a new feature",
    ],
  },

  "verify": {
    activate: [
      "I think the feature is complete, let me verify everything works",
      "I'm done with the fix. Run the tests and verify everything passes before we commit.",
      "The fix is in — verify the tests pass and the build succeeds before we move on.",
      "Before we call this complete, run the tests, verify the linter passes, and check the build succeeds. Show me the output.",
    ],
    skip: [
      "How are the tests running?",
      "We verified this yesterday and it worked fine.",
      "What's the best way to verify this?",
    ],
  },

  "worktree-cleanup": {
    activate: [
      "I'm done with this worktree, let's clean it up",
      "Clean up this worktree",
      "I've merged the PR, let's clean up the worktree",
      "Remove this worktree",
    ],
    skip: [
      "Let me clean up the code in this worktree",
    ],
  },

  "writing-plans": {
    activate: [
      "I have a spec for the new caching layer, let's create an implementation plan",
      "Use the writing-plans skill to create a step-by-step implementation plan from this requirements doc",
      "Let's create an implementation plan for migrating to the new database. I have the architecture doc ready.",
      { prompt: "The design looks good. Let's create the implementation plan now.", session: "post-brainstorm" },
    ],
    skip: [
      "Below is the implementation plan I drafted during our design session. What do you think of the approach?",
      "We have a new requirements document for the payment module. How should we approach this?",
      "This session is being continued from a previous conversation where we started planning the migration.",
    ],
  },

  // The five stories blocks below are Section D's manual trigger-check prompts,
  // verbatim (D1–D6 final steps). workspace: "stories" = D's WS_MARKER (has
  // .claude/story-workflow.json); no workspace = D's WS_BARE. The // → comments
  // mirror D's expected routing for skip prompts.
  "stories:setup": {
    activate: [
      "Set up the story workflow in this project",
      "I want to adopt the stories board here — run story init and configure the gates",
      "Install the story-based workflow in this repo with PR-mode integration",
    ],
    skip: [
      { prompt: "Break this spec into stories on the board", workspace: "stories" }, // → stories:plan
      "Set up a git worktree for this feature work", // → kit:git-worktrees
      "How do I configure ESLint for this project?",
    ],
  },

  "stories:plan": {
    activate: [
      { prompt: "Here's the approved design doc — break it down into stories on the board", workspace: "stories" },
      { prompt: "Turn docs/plans/payment-redesign.md into epics and stories with dependencies", workspace: "stories" },
      { prompt: "Populate the story board from this spec", workspace: "stories" },
    ],
    skip: [
      "I have a spec for the new caching layer, let's create an implementation plan", // → kit:writing-plans; no marker file
      { prompt: "Work through the story board until it's done", workspace: "stories" }, // → stories:work
      { prompt: "Let's brainstorm how the notification feature should behave", workspace: "stories" }, // → kit:brainstorming
    ],
  },

  "stories:work": {
    activate: [
      { prompt: "Complete all stories on the board", workspace: "stories" },
      { prompt: "Work on epic st-9c01 until it's done", workspace: "stories" },
      { prompt: "Pick up the next ready story and implement it", workspace: "stories" },
    ],
    skip: [
      { prompt: "Break this spec into stories on the board", workspace: "stories" }, // → stories:plan
      { prompt: "Stop the story loop", workspace: "stories" }, // → stories:cancel
      { prompt: "I have an implementation plan at docs/plans/x.md — execute it", workspace: "stories" }, // → kit:build-flow
    ],
  },

  "stories:cancel": {
    activate: [
      { prompt: "Stop the story loop", workspace: "stories" },
      { prompt: "Cancel the autonomous run and show me where the board stands", workspace: "stories" },
      { prompt: "Halt story work — I need to review what's happened so far", workspace: "stories" },
    ],
    skip: [
      { prompt: "Mark st-4f2a as done", workspace: "stories" }, // → stories:work / CLI
      { prompt: "Archive the completed stories", workspace: "stories" }, // → CLI `story archive`
      { prompt: "Cancel that last edit and restore the file", workspace: "stories" },
    ],
  },

  "stories:using-stories": {
    activate: [
      // Deliberately NO stories workspace: in a marker workspace the SessionStart hook
      // has already injected the using-stories content, so the model correctly answers
      // from context without re-invoking the skill. Only in a bare repo does answering
      // require the invocation these tests assert.
      "What are the rules of the story workflow when a repo uses the stories plugin?",
      "Remind me how to use the stories plugin's story CLI",
      "How does the stories-plugin story workflow operate?",
    ],
    skip: [
      { prompt: "Set up the story workflow in this project", workspace: "stories" }, // → stories:setup
      { prompt: "Complete all stories on the board", workspace: "stories" }, // → stories:work
      { prompt: "Summarize this conversation in 2-4 sentences.", workspace: "stories" },
    ],
  },
};

export const activationTests: ActivationTest[] = flatten(prompts);
