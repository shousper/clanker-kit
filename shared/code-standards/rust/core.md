# Rust standards

## Libraries

- Log with `tracing`, and configure `tracing-subscriber` once at the program entry point. Attach context as fields: `tracing::info!(user_id = %id, "user logged in")`.
- Build command-line interfaces with `clap` and its derive macros.
- Serialize with `serde`, and use `serde_json` for JSON.
- Use `tokio` as the async runtime. A library enables only the tokio features it uses and never `full`.

## Errors

- Libraries define error types with `thiserror`. Applications use `anyhow`.
- In applications, add `.context()` or `.with_context()` (from `anyhow::Context`) to every error you propagate with `?`. Libraries put that context in error variants and fields instead.
- Never discard a `Result` with `let _ =`. Handle it, propagate it, or log it.
- Use `expect` only when failure means a bug, and state the broken invariant in the message.

```rust
// Good (application):
let port: u16 = raw_port
    .parse()
    .with_context(|| format!("parse port {raw_port:?}"))?;

// Good (library): the variant carries the context.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("reading config {}", .path.display())]
    ReadConfig {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
}

// Bad:
let _ = std::fs::remove_file(&path);
```

## Traits

Define a trait only where you need substitution: a test double, several implementations, or a plugin boundary. Use concrete types everywhere else. Never pair every service with a trait and an `Impl` struct.

A trait with `async fn` isn't `dyn`-compatible. If you need `dyn`, return a boxed future or use the `async-trait` crate.

```rust
// Good: a trait for a boundary that tests replace.
pub trait Clock {
    fn now(&self) -> std::time::SystemTime;
}

// Bad: a trait with one implementation and no substitution.
pub trait Invoicer {
    fn count(&self) -> usize;
}
pub struct InvoicerImpl;
```

## Async

- Use `std::sync::Mutex` for shared state. Use `tokio::sync::Mutex` only when a guard is held across an `.await`.
- When another branch of `select!` wins, the losing futures are dropped. Use only cancellation-safe futures in `select!`, or pin the future outside the loop.
- Use `join!` for a fixed number of futures that must all finish. Use `futures::future::join_all` for a runtime-sized collection.
- Never clone a `tokio::sync::mpsc::Receiver`. It has one consumer. Clone the `Sender` for more producers.

```rust
// Good: a fixed set of futures.
let (user, orders) = tokio::join!(fetch_user(id), fetch_orders(id));

// Good: a collection of futures of the same type.
let pages = futures::future::join_all(urls.iter().map(|url| fetch_page(url))).await;
```

## Naming

- Never repeat the module name in a type: `invoice::Line`, not `invoice::InvoiceLine`.
- Name a file for its main type: `user.rs` holds `User`, not `user_struct.rs`.
- Never name a module `utils`, `helpers`, `common`, `types`, or `models`. Name it for the domain it holds.

## Tests

- Put unit tests in a `#[cfg(test)] mod tests` at the bottom of the file.
- Put integration tests in `tests/`. They use only the public API.
- Mark async tests with `#[tokio::test]`.

## Secrets

Never hardcode a secret in source. Read it from the environment or a secret store.

## Tools and CI

Run these checks in CI:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo audit
cargo deny check
```
