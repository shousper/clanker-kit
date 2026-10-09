# Go standards

## Libraries

- Use `github.com/spf13/cobra` for command-line interfaces.
- Test with `github.com/stretchr/testify` (`assert` and `require`).
- Log with `log/slog`. Inject a `*slog.Logger` through the constructor and never pass it per call.

## Package layout

- Each package is one cohesive capability. Keep types together when they share a lifecycle, change for the same reasons, and are always used together.
- Create a sub-package only when it's independent and the parent orchestrates it. Siblings never call each other.
- Name packages and files for what they hold. Never stutter (`user.User`, not `user.UserUser`), and never use generic names such as `utils`, `common`, `helpers`, `models`, `types`.

```text
// Good: independent children, orchestrated by the parent.
node/
├── node.go
├── p2p/
└── api/

// Bad: generic package.
utils/
└── helpers.go
```

## Types and interfaces

- Accept interfaces and return concrete structs. Define an interface where the consumer needs it, not next to the implementation.
- Only types that own goroutines or resources expose `Start(ctx context.Context) error` and `Stop(ctx context.Context) error`. Constructors do minimal initialization.
- Pass interfaces by value. A pointer to an interface is almost never right.
- Use `any` instead of `interface{}`.
- Use a type switch instead of repeated type assertions.

## Context and concurrency

- Every method that does I/O or can block takes `ctx context.Context` as its first parameter. Never store a context in a struct.
- Use `errgroup` for goroutine groups that can fail.
- Never write a `select` with an empty `default:` case in a loop. It busy-waits.
- Don't copy loop variables (`item := item`). In modules at Go 1.22 or later, each iteration has its own variable.
- In modules at Go 1.22 or later, use `for range n` instead of a counted loop that doesn't use the index.

## Initialization

Give `make` a capacity hint for maps and slices, particularly when you append in a loop.

```go
// Good:
names := make([]string, 0, len(users))

// Bad:
names := []string{}
```

## Errors

- Never leave an error unchecked.
- Wrap errors with context using `fmt.Errorf("load user %s: %w", id, err)`.
- Return an error when a type switch or assertion fails. Never panic.

## Testing

- Write table-driven tests for multiple scenarios.
- Mock interfaces, not implementations.
- Run tests with `-race`.

## Style

- Keep lines to a soft limit of 99 columns.
- Write a doc comment for every exported function and type.

## Linting

Respect the project's `.golangci.yml`. Run `golangci-lint` with `--new-from-rev` set to the repository's default branch, so it reports only your changes. Resolve the branch with `git symbolic-ref refs/remotes/origin/HEAD`, and never hardcode `master`.

```sh
golangci-lint run --new-from-rev="$(git symbolic-ref --short refs/remotes/origin/HEAD)"
```
