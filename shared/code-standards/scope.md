# Scope and shared rules

These rules apply to every language. Each language's `core.md` doesn't repeat them.

## Precedence

The project's own settings win over the kit standards, including its language version, tools, and tool configuration. The kit standards set the rules for new code where the project has none.

Existing code keeps its local style until a project-wide change. A project is new only when the task creates it. Language version floors and tool defaults in the standards apply only to new projects. Project settings never override the rules in this file.

## Scope limits

- Never raise the project's language version.
- Never change the build system or replace a tool unless the task asks.
- Never create a tool configuration file in an existing project unless the task asks.
- Never reformat or fix a file that the task doesn't change.
- Change a lock file only when the task changes a dependency.

## Checks

Never relax a compiler, lint, type-check or sanitizer setting to pass a check. Fix the code instead. Every line-level suppression names the rule it suppresses and gives a reason on the same line.

## Naming

Names are descriptive words or phrases. Never invent an abbreviation. One- or two-letter names are allowed only for loop indexes and conventional type parameters.

## Comments

A comment states why, never what the code already says. Never commit commented-out code, author or date lines, or TODO comments. Version control and the issue tracker hold those.

## Tests

A test name states the unit and the expected behavior. Cover behavior and edge cases. There is no coverage target, so never write a test only to raise coverage.

## Secrets

Never log, print, or commit a secret. Read secrets from the environment or a secret store.
