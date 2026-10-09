# Python standards

## Dependencies

- If the project has no tool for a job, use the default below.

| Job | Default |
|---|---|
| Environment and dependencies | uv |
| Lint and format | ruff |
| Type check | mypy in strict mode |
| Tests | pytest |
| Logging | `logging` from the standard library |
| Command-line parsing | `argparse` from the standard library |

- If the project has a type checker, such as mypy, pyright, pyrefly or ty, use it. Never add a second type checker.
- Declare every dependency in `pyproject.toml`. Never install a package ad hoc.

## Environment and commands

- Run every tool through the project's environment manager. If the project uses Poetry or Hatch, use its run command in place of `uv run`.
- Never use the system Python, and never install a package into it.
- If the project uses uv, run `uv sync --locked` before the first `uv run`. Change a dependency with `uv add` or `uv remove`. If `uv.lock` is stale for another reason, stop and report it.
- Fix and format only the files that the task changes: `uv run ruff check --fix PATH` and `uv run ruff format PATH`.
- Never pass `--select` to ruff on the command line. It replaces the configured rule set.
- If a check fails only in an unchanged file, report it and leave the file alone.
- A line-level suppression names its code and gives a reason:

```python
import legacy_client  # type: ignore[import-untyped]  # the library ships no stubs
from project_name.api import Client  # noqa: F401  # re-exported for the public API
```

## Language level

- Write builtin generics (`list[str]`) and `X | None`, never `List` or `Optional`.
- On 3.12 and later, write generics as `def last[T](items: Sequence[T]) -> T` and aliases as `type Vector = Sequence[float]`.

## Type hints

- Parameters take the narrowest abstract type, such as `Iterable` or `Sequence`. Returns name the concrete type the caller receives.
- Use `Protocol` over `ABC`, unless the base class shares behavior. Add `@runtime_checkable` only when you need `isinstance`.
- Use `NewType` for identifiers that must not be mixed up. Use `StrEnum` or `Literal` for a closed set, and handle it with `match` and `assert_never`.
- Hide a secret field from `repr` with `field(repr=False)`.
- Use `Any` only at an I/O boundary, and convert it to a typed value at once. Never return `Any` or store it in an attribute.

```python
# Good: the closed set is checked for exhaustiveness
def device_label(device: Device) -> str:
    match device:
        case Device.CPU:
            return "CPU"
        case Device.GPU:
            return "GPU"
        case _:
            assert_never(device)


# Bad: any string is accepted, and a typo surfaces at run time
def device_label(device: str) -> str: ...
```

## Docstrings

- Write Google-style docstrings for the public API. Tests need no docstring.
- Document constructor arguments under Args in the class docstring.
- Never repeat a type or default that the signature states.

## Error handling

- Each package has one base exception. Callers catch it to handle every error from the package.
- Chain the cause with `raise ... from err`.
- Keep the `try` body to the statement that can raise.
- Name the operation and the value in the message.

```python
# Good: the cause is chained, and the message names the operation and value
try:
    text = path.read_text(encoding="utf-8")
except OSError as err:
    raise ConfigError(f"cannot read config file {path}") from err

# Bad: no context, no cause chain
except OSError:
    raise ValueError("bad config")
```

## Logging

- Create one `logger = logging.getLogger(__name__)` at module level.

## Security

- Treat every value from a network, a file, an environment variable, or a user as untrusted.
- Never call `eval` or `exec`. Never unpickle untrusted data.
- Never run a shell command built from a string. Call `subprocess.run` with an argument list and no `shell=True`.
- Never build SQL with string formatting. Use parameterized queries.
- Load YAML only with `yaml.safe_load`.
- Generate a token with the `secrets` module. Never use `random` for a secret.
- Compare secrets with `hmac.compare_digest`.
- The ruff `S` rules report most of these defects.

## Code organization

- If a library reads annotations at run time, such as pydantic or typer, never move an import that annotations use under `TYPE_CHECKING`.

## Naming

| Kind | Rule | Example |
|---|---|---|
| Class | PascalCase noun | `ModelTrainer` |
| Function | snake_case verb phrase | `train_model` |
| Variable | snake_case noun, plural for a collection | `documents` |
| Boolean | `is_`, `has_` or `can_` prefix | `is_active` |
| Constant | UPPER_SNAKE_CASE with `Final` | `MAX_SEQUENCE_LENGTH` |
| Private | leading underscore | `_internal_cache` |
| Protocol | capability noun or adjective | `MetricSource`, `SupportsClose` |

- The allowed short forms are `cls`, `err`, `config`, `url` and the `_id` suffix. Name a caught exception `err`.
- Never shadow a builtin, such as `id`, `list`, `type`, `input` or `filter`.

| Bad | Good |
|---|---|
| test function `test_parse_golden` | `test_parse_config_rejects_missing_database_key` |
| file `combined_smoke.py` | `export_pipeline_end_to_end.py` |
| class `_MsgBuf` or `AccumulateMessages` | `MessageBuffer` or `MessageAccumulator` |
| variables `r` and `n_req` | `retry_ratio` and `request_count` |

## Design principles

- High-level code depends on a protocol. Build the concrete object once at the composition root, and inject it through the constructor.

```python
# Good: constructor injection of a protocol
class UserService:
    def __init__(self, users: UserRepository) -> None:
        self._users = users


# project_name/cli/main.py is the composition root
service = UserService(PostgresUserRepository(database_url))

# Bad: the service builds its own connection
class UserService:
    def __init__(self) -> None:
        self._database = PostgresConnection(os.environ["DATABASE_URL"])
```

## Data and control flow

- Make every optional parameter keyword-only with `*`.
- Default to `@dataclass(frozen=True, slots=True)`. Add `kw_only=True` past 3 fields.
- Choose the container by where the data lives:
  - `dataclass`: in-process domain objects with behavior or invariants.
  - `NamedTuple`: small immutable records that are also unpacked or indexed.
  - `TypedDict`: dict-shaped data at an I/O boundary, such as JSON, YAML or `**kwargs`.
  - `Enum` or `StrEnum`: closed sets of named values.
- Never pass a bare tuple of mixed types between functions. Wrap the values in one of these containers.
- Declare module constants with `Final`. Use a `tuple` or `frozenset` for a fixed collection, never a module-level `list` or `set`.

## Async

- Use `asyncio.TaskGroup` inside `asyncio.timeout` for concurrent work. Keep a reference to every task you create.
- Move a blocking call off the event loop with `asyncio.to_thread`.

## Testing

- Use pytest. Use `parametrize` in place of a loop or branch in a test body.
- Compare floats with `pytest.approx`.
- Share setup through fixtures in `conftest.py`.
- Replace a collaborator with a stub that implements its protocol. Use `unittest.mock` only at a system boundary.
- Never call `time.sleep` in a test. Inject a clock.

```python
@pytest.mark.parametrize(
    ("device", "expected"),
    [(Device.CPU, "CPU"), (Device.GPU, "GPU")],
    ids=["cpu", "gpu"],
)
def test_device_label_matches_device(device: Device, expected: str) -> None:
    assert device_label(device) == expected
```
