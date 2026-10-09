# Rust project standards

These rules apply when the task creates a project or changes its build or tool configuration.

## Toolchain

- Use edition 2024, and set `rust-version` once, in `[workspace.package]`.
- Commit `Cargo.lock` for binaries and pin the toolchain with `rust-toolchain.toml`.

## Workspace layout

Use a workspace when the project has more than one crate. Name each crate for the capability it holds.

```text
project/
├── Cargo.toml
├── Cargo.lock
└── crates/
    ├── api/
    ├── cli/
    └── store/
```

Declare the edition, minimum Rust version and lints once in the root `Cargo.toml`. Member crates inherit them.

```toml
[workspace]
resolver = "3"
members = ["crates/*"]

[workspace.package]
edition = "2024"
rust-version = "1.85" # Edition 2024 needs 1.85 or newer.

[workspace.lints.clippy]
unwrap_used = "deny"
```

Each member opts in to the shared settings:

```toml
[package]
name = "api"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true

[lints]
workspace = true
```

## Clippy configuration

Allow `unwrap` in tests so the `unwrap_used` deny applies only to production code. Create `clippy.toml` in the workspace root:

```toml
allow-unwrap-in-tests = true
```
