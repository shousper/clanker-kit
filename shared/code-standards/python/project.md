# Python project standards

These rules apply when the task creates a project or changes its build or tool configuration.

## Setup

- Declare `requires-python = ">=3.12"`.
- List `.venv/` in `.gitignore`.
- Use uv for the environment and `uv_build` as the build backend.
- If the task targets a version below 3.12, use only the syntax and standard library that version supports.

## Tool configuration

Start from this `pyproject.toml` and keep every tool setting in it.

```toml
[project]
name = "project_name"
version = "0.1.0"
requires-python = ">=3.12"

[build-system]
requires = ["uv_build>=0.12,<0.13"]
build-backend = "uv_build"

[dependency-groups]
dev = ["ruff>=0.16", "mypy>=2.4", "pytest>=9.1", "pytest-cov>=7.1"]

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
"tests/**" = ["D", "PLR2004", "S101"]
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

## File organization

Group modules by domain concept, not by kind. Never create `utils`, `helpers`, `common` or `misc` modules. Never name a module after a standard-library module, such as `logging.py`, `types.py` or `json.py`.

```text
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
│   └── __init__.py          # Lets test files in two folders share a name
└── integration/
    └── __init__.py
```
