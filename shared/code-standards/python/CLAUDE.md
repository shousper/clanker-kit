# Python Standards

These standards apply to all work on Python files. Every rule is a requirement. A rule that starts with "If" applies only when its condition is true. Examples omit the imports, definitions and bodies that the section does not discuss.

## Scope and Precedence

- The settings of the project win over this file. These include the language version, the tools and their configuration.
- This file sets the rules for new code where the project has no rule of its own.
- Existing code keeps its local style until a project-wide change.
- Project settings never override the Never rules in this section or the Security rules.
- Never raise the language version of the project.
- Never change the build system or replace a tool of the project unless the task asks for it.
- Never create a tool configuration file in an existing project unless the task asks for it.
- Never reformat or fix a file that the task does not change.
- Never update a lock file unless the task changes a dependency.
- Never relax a compiler, lint, type-check or sanitizer setting to pass a check. Fix the code.
- A line-level suppression, such as `# noqa` or `# type: ignore`, names its code and gives a reason.
- Never log, print or commit a secret.

## Dependencies

- A new project declares `requires-python = ">=3.12"`.
- If the project targets a version below 3.12, use only the syntax and standard library that version supports.
- If the project has no tool of its own for a job, use the default below.

| Job | Default |
|---|---|
| Environment and dependencies | uv |
| Lint and format | ruff |
| Type check | mypy in strict mode |
| Tests | pytest |
| Logging | `logging` from the standard library |
| Command-line parsing | `argparse` from the standard library |

- If the project already has a type checker, such as mypy, pyright, pyrefly or ty, use it. Never add a 2nd type checker.
- Declare every dependency in `pyproject.toml`. Never install a package ad hoc.
- Give each development tool in the `dev` dependency group a lower bound, as the template below does.

## Environment and Commands

- Run every tool through the environment manager of the project. A new project uses uv.
- If the project uses another manager, such as Poetry or Hatch, use its run command in place of `uv run`.
- If the project uses uv, run `uv sync --locked` before the 1st `uv run`. If the task changes a dependency, change it with `uv add` or `uv remove`. If `uv.lock` is out of date for another reason, stop and report it. If `uv.lock` is missing, create it with `uv sync`.
- In an existing project, run only the tools it installs. Report each missing check.
- Never use the system Python. Never install a package into it.
- A new project lists `.venv/` in `.gitignore`.

Fix and format only the files that the task changes:

```bash
uv run ruff check --fix src/project_name/changed_module.py
uv run ruff format src/project_name/changed_module.py
```

Run the checks of the project. If it has none, run these 4 commands:

```bash
uv run ruff format --check
uv run ruff check
uv run mypy
uv run pytest
```

- If a check fails only in an unchanged file, report it and leave the file unchanged.
- If the mypy configuration sets no `files`, pass the changed paths to `uv run mypy`.
- Never pass `--select` to ruff on the command line. It replaces the configured rule set.

## Language Level

Target the version in `requires-python`. A new project declares `>=3.12`, which provides the syntax below. Write the modern form. Never write the legacy form. PEP 695 syntax needs mypy 1.12 or newer.

```python
# Good: builtin generics, PEP 604 unions, PEP 695 generics and aliases
from collections.abc import Sequence

type Vector = Sequence[float]


def first_value(values: Vector) -> float | None:
    """Return the first value, or None when the sequence is empty."""
    return values[0] if values else None


def last_item[T](items: Sequence[T]) -> T:
    """Return the last item of a non-empty sequence."""
    return items[-1]


# Bad: legacy typing aliases (ruff UP006, UP035, UP045)
from typing import List, Optional


def first_value(values: List[float]) -> Optional[float]: ...
```

## Formatting

- The line length is 88 characters, the ruff default. Indent with 4 spaces. Use double quotes.
- Put a trailing comma on every multi-line call, signature and literal. The formatter then keeps 1 item per line.

## Type Hints

Every function, method, attribute and module-level variable has a complete type. The type checker passes with the configuration of the project.

### Function Signatures
Parameters name the smallest capability the function needs. Return types name the exact type the caller receives.

```python
from collections.abc import Iterable, Sequence


# Good: callers can pass a list, tuple, generator or dict view
def total_bytes(files: Iterable[FileStat]) -> int:
    """Return the combined size of `files`."""
    return sum(file.size for file in files)


# Good: Sequence when the function indexes or takes len(), and the return is concrete
def tail(values: Sequence[float], count: int) -> list[float]:
    """Return the last `count` values."""
    return list(values[max(len(values) - count, 0) :])


# Bad: the parameters have no types
# Bad: `any` is the builtin function, not `typing.Any` (mypy: not valid as a type)
# Bad: `dict[str, Any]` as a return type hides the shape of the result
def process_file(input_path, output_path=None) -> dict[str, any]: ...
```

### Narrow Types Over Primitives
Replace magic strings and bare `str` or `int` identifiers with a closed or distinct type. Handle a closed set with `match` and `assert_never`. The type checker then reports every unhandled member.

```python
from enum import StrEnum
from typing import Literal, NewType, assert_never


# Good: a closed set of values with an Enum
class Device(StrEnum):
    """Compute devices that the model supports."""

    CPU = "cpu"
    GPU = "gpu"


# Good: Literal for a small fixed set that is not worth an Enum
type OpenMode = Literal["r", "w"]

# Good: NewType keeps different identifiers apart at type-check time
UserId = NewType("UserId", str)
SessionId = NewType("SessionId", str)


# Good: exhaustive matching over the closed set
def device_label(device: Device) -> str:
    """Return the display name of `device`."""
    match device:
        case Device.CPU:
            return "CPU"
        case Device.GPU:
            return "GPU"
        case _:
            assert_never(device)


# Bad: any string is accepted, and typos are found at run time
def run_model(device: str = "gpu") -> None: ...
```

### Structural Typing With Protocols
Define behavior contracts with `Protocol`. Implementations never inherit from the protocol. Use an `ABC` only when the base class provides shared behavior that subclasses reuse. Use `@runtime_checkable` only when an `isinstance` check is required. It checks method names only, not signatures.

```python
from collections.abc import Iterable
from typing import Protocol


class MetricSource(Protocol):
    """Supplies recent samples for a named metric."""

    def samples(self, metric: str, *, limit: int) -> Iterable[float]:
        """Return up to `limit` recent samples of `metric`."""


def moving_average(source: MetricSource, metric: str, *, window: int) -> float:
    """Return the mean of the last `window` samples of `metric`."""
    samples = list(source.samples(metric, limit=window))
    if not samples:
        raise ValueError(f"no samples for metric {metric}")
    return sum(samples) / len(samples)


# Bad: duck typing checked by hand, so the type checker cannot help
def moving_average(source, metric, *, window):
    if not hasattr(source, "samples"):
        raise TypeError("source must have samples")
```

### Class Type Hints
- Hide every secret field from repr with `field(repr=False)`.

```python
from dataclasses import dataclass, field
from typing import ClassVar


@dataclass(frozen=True, slots=True, kw_only=True)
class APIConfig:
    """Connection settings for the API client."""

    SUPPORTED_SCHEMES: ClassVar[frozenset[str]] = frozenset({"https"})

    base_url: str
    api_key: str = field(repr=False)
    timeout_seconds: float = 30.0
```

### Any and Type Ignores
```python
from typing import Any


# Good: a narrow Any at an untyped boundary, converted immediately
def parse_payload(raw: dict[str, Any]) -> Ticket:
    """Convert a decoded JSON object to a ticket."""
    return Ticket(identifier=str(raw["id"]), priority=int(raw["priority"]))


# Bad: Any in a return type or attribute leaks through the whole call graph
def load(path: Path) -> Any: ...
```

```python
# Good: every ignore carries an error code and a reason
import legacy_client  # type: ignore[import-untyped]  # the library ships no type stubs

# Bad: a blanket ignore
import legacy_client  # type: ignore
```

## Docstrings

The summary line is 1 sentence that ends with a period. The summary of a function or method, other than a test, is in the imperative mood. Never repeat defaults or types that the signature already states. If the summary of a public function leaves an argument, result or error unclear, add Args, Returns or Raises. Private helpers get a 1-line docstring.

Document constructor arguments once, under Args in the class docstring. List under Attributes only the attributes that are not constructor arguments.

```python
def process_data(records: Sequence[Record], *, batch_size: int = 32) -> ProcessResult:
    """Process records in batches and collect per-record errors.

    Args:
        records: Records to process.
        batch_size: Number of records per batch.

    Returns:
        Counts of processed records and the errors that occurred.

    Raises:
        ValueError: If `records` is empty.
    """
    if not records:
        raise ValueError("records must not be empty")
    return ProcessResult(success_count=len(records))


class DataProcessor:
    """Runs the validate, transform and batch steps over input records.

    Args:
        config: Connection settings used by the transform step.

    Attributes:
        metrics: Counters updated by every `process` call.
    """

    def __init__(self, config: APIConfig) -> None:
        self.config = config
        self.metrics = ProcessMetrics()
```

## Error Handling

An error message names the operation and the value that failed. If a value is invalid, the message also names the expected value. Chain the cause with `from`.

```python
import tomllib
from pathlib import Path


# Good: 1 project exception, the cause chained, no exists-then-read race
def load_config(path: Path) -> RawConfig:
    """Load and validate a TOML configuration file."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as err:
        raise ConfigError(f"cannot read config file {path}") from err
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError as err:
        raise ConfigError(f"invalid TOML in config file {path}: {err}") from err
    return validate_raw_config(document, source=path)


# Bad: a generic error with no context and no cause chain (ruff B904)
def load_config(path):
    try:
        return tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError:
        raise ValueError("bad config")
```

### Custom Exceptions
Each package has 1 base exception. Callers catch the base to handle every error from that package.

```python
class AppError(Exception):
    """Base exception for the application."""


class ConfigError(AppError):
    """A configuration file is missing or malformed."""
```

### Narrow Try Blocks
The `try` body holds only the statement that can raise. Code that depends on success goes in `else`. If every handler raises or returns, it can follow the `try` statement instead.

```python
# Good: the try body holds only the statement that can raise
def load_parsed_config(path: Path) -> Config:
    """Read and parse the configuration file at `path`."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as err:
        raise ConfigError(f"Cannot read {path}") from err
    else:
        return parse_config(raw)


# Bad: the handler also hides errors raised by parse_config
def load_parsed_config(path: Path) -> Config | None:
    try:
        raw = path.read_text(encoding="utf-8")
        return parse_config(raw)
    except Exception:
        return None
```

### Missing Keys
- Use `.get()` with a default for an optional key.
- Use `try` and `except KeyError` for a required key, and raise the project error.

## Logging

Use the `logging` module with 1 module-level logger per module. Never use `print` outside a command-line entry point (ruff T20).

```python
import logging

logger = logging.getLogger(__name__)


# Good: lazy %-formatting, and `exception` keeps the traceback
def load_records(path: Path) -> list[Record]:
    """Read the records at `path` and log how many were loaded."""
    try:
        records = read_records(path)
    except OSError:
        logger.exception("Could not read records from %s", path)
        raise
    logger.info("Loaded %d records from %s", len(records), path)
    return records


# Bad: f-string is formatted even when INFO is disabled (ruff G004)
logger.info(f"Loaded {len(records)} records from {path}")


# Bad: traceback lost (ruff TRY400), and the error is swallowed
def load_records(path: Path) -> list[Record]:
    try:
        return read_records(path)
    except OSError as err:
        logger.error("read failed: %s", err)
        return []
```

## Security

- Treat every value from a network, a file, an environment variable or a user as untrusted.
- Never call `eval` or `exec`. Never unpickle untrusted data.
- Never run a shell command built from a string. Call `subprocess.run` with an argument list and no `shell=True`.
- Never build SQL with string formatting. Use parameterized queries.
- Load YAML only with `yaml.safe_load`.
- Generate a token with the `secrets` module. Never use `random` for a secret.
- Compare secrets with `hmac.compare_digest`.
- The ruff `S` rules report most of these defects.

## Code Organization

Order imports in 3 groups with a blank line between them. The groups are the standard library, third-party packages and local modules. The ruff `I` rules enforce the order. Never use `from module import *`. Never use relative imports (ruff TID252).

If an import that only annotations use causes an import cycle, put it under `TYPE_CHECKING`. If `requires-python` allows a version below 3.14, also add `from __future__ import annotations`. In a module whose annotations a library reads at run time, never move an import under `TYPE_CHECKING`. Pydantic and typer read annotations at run time.

```python
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from project_name.core.processor import Processor


def run(processor: Processor) -> None:
    """Run `processor` once."""
```

### Module Layout
1. Module docstring
2. `from __future__` imports
3. Imports
4. `__all__` (public modules only)
5. Constants and type aliases
6. Exceptions
7. Protocols and dataclasses
8. Classes and functions
9. `if __name__ == "__main__":` guard (entry-point modules only)

### Class Layout
Order inside a class: class variables, `__init__`, other dunder methods, properties, public methods, private methods. If `typing.override` is available, every override except `__init__` and `__new__` carries `@override`, including dunder methods such as `__repr__`.

## Naming Conventions

| Kind | Rule | Example |
|---|---|---|
| Class | PascalCase noun | `ModelTrainer` |
| Function | snake_case verb phrase | `train_model` |
| Variable | snake_case noun, plural for a collection | `documents` |
| Boolean | `is_`, `has_` or `can_` prefix | `is_active` |
| Constant | UPPER_SNAKE_CASE with `Final` | `MAX_SEQUENCE_LENGTH` |
| Private | leading underscore | `_internal_cache` |
| Protocol | capability noun or adjective | `MetricSource`, `SupportsClose` |

A name is a full, descriptive noun or verb phrase. Never use a single-letter name, except loop indexes `i` and `j`, an unused `_` and a type parameter `T`. Never invent an abbreviation. The allowed short forms are common ones, such as `cls`, `err`, `config`, `url` and the `_id` suffix. Name a caught exception `err`. Never shadow a builtin, such as `id`, `list`, `type`, `input` or `filter`.

| Bad | Good |
|---|---|
| test function `test_parse_golden` | `test_parse_config_rejects_missing_database_key` |
| file `combined_smoke.py` | `export_pipeline_end_to_end.py` |
| class `_MsgBuf` or `AccumulateMessages` | `MessageBuffer` or `MessageAccumulator` |
| variables `r` and `n_req` | `retry_ratio` and `request_count` |

## Design Principles

- A function or class has 1 reason to change. If its name needs "and", split it.
- A function stays within the ruff limits for branches (PLR0912) and statements (PLR0915).
- Add behavior with a new implementation that registers once. Never extend an `if` chain on a type or format.
- A subclass accepts every input of its base and keeps every promise of its base. If it cannot, use a smaller protocol and no inheritance.
- A caller depends on the smallest protocol that covers what it calls.
- Inherit only for a true is-a relationship with a stable base contract. Reuse code by wrapping and delegating.
- High-level code depends on a protocol. Build the concrete object once at the composition root, and inject it through the constructor.

```python
# Good: constructor injection of a protocol
class UserRepository(Protocol):
    """Looks up users."""

    def by_id(self, identifier: UserId) -> User:
        """Return the user with `identifier`."""


class UserService:
    """Use cases for users."""

    def __init__(self, users: UserRepository) -> None:
        self._users = users


# project_name/cli/main.py is the composition root
service = UserService(PostgresUserRepository(database_url))


# Bad: the service builds its own connection
class UserService:
    def __init__(self) -> None:
        self._database = PostgresConnection(os.environ["DATABASE_URL"])
```

## Data and Control Flow

### Use Keyword-Only Arguments
Make every optional parameter keyword-only with `*`. Never accept a boolean as a positional argument (ruff FBT). If the name of a parameter is not part of the API, mark it positional-only with `/`.

```python
# Good: keyword-only options cannot be mixed up
def train(
    batches: Iterable[Batch],
    *,
    epochs: int = 3,
    seed: int = 0,
) -> None:
    """Train on `batches`."""


# Bad: positional options, so swapped epochs and seed still pass the type check
def train(batches: Iterable[Batch], epochs: int = 3, seed: int = 0) -> None: ...
```

### Use Dataclasses
Default to `frozen=True` and `slots=True`. If the class has more than 3 fields, use `kw_only=True`.

```python
from dataclasses import dataclass


@dataclass(frozen=True, slots=True, kw_only=True)
class Config:
    """Training run settings."""

    model_name: str
    learning_rate: float = 1e-4
    epochs: int = 3
    tags: tuple[str, ...] = ()
```

Choose the container by where the data lives:
- `dataclass`: in-process domain objects with behavior or invariants.
- `NamedTuple`: small immutable records that are also unpacked or indexed.
- `TypedDict`: dict-shaped data at an I/O boundary (JSON, YAML, `**kwargs`).
- `Enum` / `StrEnum`: closed sets of named values.

Wrap a group of related values of different types in 1 of these containers. Never pass a bare tuple of mixed types between functions. Use `dict[str, Any]` only at an I/O boundary, and convert it at once. If the project uses NumPy, type arrays with `NDArray`.

### Immutability by Default
```python
from typing import Final

# Good: tuple for a fixed collection, frozenset for a fixed set
SUPPORTED_FORMATS: Final = frozenset({"csv", "json"})
RETRY_DELAYS_SECONDS: Final = (1, 2, 4)

# Bad: a mutable module-level collection that any caller can change
SUPPORTED_FORMATS = ["csv", "json"]
```

### Control Flow Rules
- Use `pathlib.Path` and pass `encoding="utf-8"` to every text read and write (ruff PTH).
- Open every resource with a `with` block. Use `contextlib.ExitStack` for several resources (ruff SIM115).
- Return early with guard clauses. Keep the main path at 1 level of indentation (ruff RET).
- Compare with `is None` and `isinstance`. Test emptiness with `not items` (ruff E711, E721).
- Create every datetime with a timezone, such as `datetime.now(tz=UTC)` (ruff DTZ).
- Never use a mutable default argument (ruff B006).
- Never write a bare `except` or an `except` that only passes (ruff E722, S110).
- Never use `assert` for run-time validation. `python -O` removes it (ruff S101).
- Use `match` or polymorphism in place of an `isinstance` chain.
- Never keep global mutable state.
- Raise an exception for an exceptional absence. Return `None` only when absence is a normal result.

## Performance

Measure first. Optimize only the path that the profile shows.

```bash
uv run python -m cProfile -o profile.out -m project_name.cli.main run
```

```python
from collections import Counter, deque


# Good: the standard library in place of a hand-written loop
def recent_kind_counts(events: Iterable[Event], *, window: int) -> Counter[str]:
    """Count the kinds of the last `window` events."""
    return Counter(event.kind for event in deque(events, maxlen=window))


# Good: a generator keeps memory flat for a stream
def iter_records(path: Path) -> Iterator[Record]:
    """Yield the records in the file at `path`."""
    with path.open(encoding="utf-8") as record_file:
        for line in record_file:
            yield parse_record(line)
```

- Use a `set` for membership tests in a loop. Use `deque` for a queue, `heapq` for a priority queue and `bisect` for sorted lookups.
- Build a string with `"".join()`, never with `+=` in a loop.
- Cache a pure, expensive function with `functools.cache`.
- Inside a measured hot loop, move invariant work out of the loop.
- If the project uses NumPy or pandas, use vector operations in place of Python loops over numbers or rows.
- I/O-bound work with many connections uses `asyncio`. A blocking I/O library uses `asyncio.to_thread` or `ThreadPoolExecutor`.
- On the default CPython build, threads do not speed up CPU-bound pure Python because of the GIL. Use `ProcessPoolExecutor`.
- A command-line tool imports a heavy module inside the command that needs it. Suppress PLC0415 on that line with the reason.

## Async

```python
import asyncio


# Good: structured concurrency and an explicit timeout
async def fetch_all(client: Client, urls: Sequence[str]) -> list[Response]:
    """Fetch every url, and fail all requests together after 10 seconds."""
    async with asyncio.timeout(10):
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(client.fetch(url)) for url in urls]
    return [task.result() for task in tasks]


# Good: blocking call moved off the event loop
async def load(path: Path) -> str:
    """Read the text file at `path`."""
    return await asyncio.to_thread(path.read_text, encoding="utf-8")


# Bad: blocking the event loop
async def load(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# Bad: a task with no reference can be garbage collected (ruff RUF006)
asyncio.create_task(client.fetch(url))
```

## Testing

Use pytest. Every test has a docstring that states its objective. Every assertion has a failure message. For `pytest.raises`, the `match` argument is the failure criterion.

```python
import pytest


def test_moving_average_uses_only_the_last_window_samples() -> None:
    """A window of 2 must ignore samples older than the last 2 observations."""
    source = StubMetricSource([1.0, 2.0, 4.0])

    average = moving_average(source, "latency", window=2)

    assert average == pytest.approx(3.0), (
        "average must cover the 2 most recent samples only"
    )


def test_validate_config_reports_every_missing_key() -> None:
    """All absent required keys must appear in 1 ConfigError."""
    with pytest.raises(ConfigError, match=r"\['database', 'api_key'\]"):
        validate_config({"settings": {}})


@pytest.mark.parametrize(
    ("device", "expected"),
    [(Device.CPU, "CPU"), (Device.GPU, "GPU")],
    ids=["cpu", "gpu"],
)
def test_device_label_matches_device(device: Device, expected: str) -> None:
    """CPU maps to "CPU" and GPU maps to "GPU"."""
    assert device_label(device) == expected, f"{device} must map to {expected}"
```

- A test name states the unit and the expected behavior: `test_<unit>_<behavior>`.
- Separate arrange, act and assert with 1 blank line.
- Never put a branch or a loop in a test body. Use `parametrize`.
- Compare floats with `pytest.approx`.
- Share setup through fixtures in `conftest.py`. Never use setup methods.
- Replace a collaborator with a stub that implements its protocol. Use `unittest.mock` only at a system boundary.
- Never call `time.sleep` in a test. Inject a clock.
- Use coverage to find untested code. Never write a test only to raise the number.

## Tool Configuration

A new project starts from this `pyproject.toml` and keeps every tool setting in it.

```toml
[project]
name = "project_name"
version = "0.1.0"
requires-python = ">=3.12"

[build-system]
requires = ["uv_build>=0.12,<0.13"]
build-backend = "uv_build"

[dependency-groups]
dev = ["ruff>=0.16", "mypy>=2.3", "pytest>=9.1", "pytest-cov>=7.1"]

[tool.ruff]
# target-version is inferred from requires-python
src = ["src", "tests"]

[tool.ruff.lint]
select = [
    "E", "W", "F", "I", "UP", "B", "A", "C4", "SIM", "PTH", "PIE", "RET", "RUF",
    "PERF", "N", "D", "ANN", "TRY", "G", "FBT", "S", "PL", "T20", "TID", "DTZ", "PT", "ASYNC",
]
# TRY003: an error message carries the context of the failure
# D107: constructor arguments are documented on the class
ignore = ["TRY003", "D107"]

[tool.ruff.lint.pydocstyle]
convention = "google"

[tool.ruff.lint.flake8-tidy-imports]
ban-relative-imports = "all"

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["PLR2004", "S101"]
"src/project_name/cli/**" = ["T20"]

[tool.mypy]
python_version = "3.12"
files = ["src", "tests"]
strict = true
warn_unreachable = true
enable_error_code = [
    "explicit-override", "ignore-without-code", "possibly-undefined", "truthy-bool",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "--strict-markers --strict-config"

[tool.coverage.run]
source = ["src"]
branch = true
```

## File Organization

Group modules by domain concept, not by kind. Never create `utils`, `helpers`, `common` or `misc` modules. Never name a module after a standard-library module (`logging.py`, `types.py`, `json.py`).

```
pyproject.toml               # Metadata, dependencies and every [tool.*] table
src/project_name/
├── __init__.py
├── py.typed                 # Marks the package as typed for downstream users
├── config.py                # Settings dataclasses and loaders
├── errors.py                # Exception hierarchy
├── documents/               # A package per domain concept
│   ├── __init__.py
│   ├── models.py            # Dataclasses, enums, protocols; no I/O
│   ├── repository.py        # Storage adapters that implement the protocols
│   └── service.py           # Use cases composed from models and adapters
└── cli/
    ├── __init__.py
    └── main.py              # Composition root
tests/
├── conftest.py
├── unit/                    # Mirrors src/project_name/
│   └── __init__.py          # Lets test files in 2 folders share a name
└── integration/
    └── __init__.py
```
