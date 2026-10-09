#!/usr/bin/env bash
# Formats/checks exactly the files given as arguments, via the per-extension
# handler table below (single source of the whole kit formatter pipeline — do
# not duplicate this table elsewhere). Prints a plain-text summary of anything
# a handler reports (a first-detection notice, or non-blocking lint/check
# findings); silent + exit 0 on a clean run. Exits 0 regardless of individual
# formatter/checker failures — this NEVER blocks the caller.
# handle_* functions and their helpers are called indirectly by run().
# shellcheck disable=SC2329
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
. "${script_dir}/lib.sh"
export KIT_HOOKS_DIR="$script_dir"   # handlers that shell out to hcl-tool.sh use this

KIT_FILES=("$@")

# select_files <glob>...  — from KIT_FILES[], print existing files matching any glob,
# one per line.
select_files() {
  local f g
  for f in "${KIT_FILES[@]}"; do
    [ -f "$f" ] || continue
    # $g is intentionally an unquoted glob pattern (e.g. *.go) for case matching.
    # shellcheck disable=SC2254
    for g in "$@"; do case "$f" in $g) printf '%s\n' "$f"; break ;; esac; done
  done
}

# Handlers: receive a newline-separated file list ($1), print a finding (or nothing).
# Formatters mutate files in place; on success they print nothing. They MUST keep
# tool output off stdout (the caller folds all handler stdout into its summary).
handle_gofmt() {
  [ -n "$1" ] || return 0
  command -v gofmt >/dev/null 2>&1 || return 0
  local fs; mapfile -t fs <<<"$1"
  gofmt -w "${fs[@]}" >/dev/null 2>&1 || true   # formatter: no finding on success
}
handle_rustfmt() {
  [ -n "$1" ] || return 0
  command -v rustfmt >/dev/null 2>&1 || return 0
  local fs; mapfile -t fs <<<"$1"
  rustfmt "${fs[@]}" >/dev/null 2>&1 || true
}
# HCL: fmt touched files (per directory), tflint if configured. Reuses
# hcl-tool.sh (unchanged) via KIT_HOOKS_DIR for detection/state.
# Ported from hooks/hcl-fmt.sh:31-86 — stdin/scratch plumbing lives in the
# caller; notice+findings are returned as this handler's printed string.
#
# Deliberately does NOT run `tofu/terraform validate`: validate cross-checks the
# config against the provider set captured at the last `init`, so any edit that
# changes the required providers (new provider/resource/module, changed source)
# makes it emit a spurious "Missing required provider — run init" right after an
# ordinary edit. fmt is hermetic; validate is not. Leave validation to CI / an
# explicit user run.
handle_hcl() {
  [ -n "$1" ] || return 0
  local hcl_tool="${KIT_HOOKS_DIR}/hcl-tool.sh"
  [ -x "$hcl_tool" ] || return 0

  local files dirs
  mapfile -t files <<<"$1"
  mapfile -t dirs < <(printf '%s\n' "${files[@]}" | while IFS= read -r f; do dirname "$f"; done | sort -u)

  local notice="" findings="" dir in_dir f fresh tool other out cfg_found d
  for dir in "${dirs[@]}"; do
    [ -d "$dir" ] || continue

    in_dir=()
    for f in "${files[@]}"; do
      [ "$(dirname "$f")" = "$dir" ] && [ -f "$f" ] && in_dir+=("$f")
    done
    [ "${#in_dir[@]}" -gt 0 ] || continue

    # Atomically claim the first detection (locked check-and-set in hcl-tool.sh):
    # `fresh` is non-empty only for the single invocation that first detects this
    # project, so the notice fires exactly once even under concurrent runs.
    fresh="$("$hcl_tool" first-detect "$dir")"
    tool="$("$hcl_tool" resolve "$dir")"
    command -v "$tool" >/dev/null 2>&1 || continue

    if [ -n "$fresh" ] && [ -z "$notice" ]; then
      other="terraform"; [ "$tool" = "terraform" ] && other="tofu"
      notice="Detected ${tool} for this project. Override with /kit:hcl-tool ${other}."
    fi

    # 1. fmt — the touched files only (in place; safe at end of turn).
    "$tool" fmt "${in_dir[@]}" >/dev/null 2>&1 || true

    # 2. tflint — only if installed and configured nearby.
    if command -v tflint >/dev/null 2>&1; then
      cfg_found=""
      d="$dir"
      while :; do
        [ -f "$d/.tflint.hcl" ] && { cfg_found="$d/.tflint.hcl"; break; }
        [ "$d" = "/" ] && break
        d="${d%/*}"
        [ -n "$d" ] || d="/"
      done
      if [ -n "$cfg_found" ]; then
        out="$(tflint --chdir="$dir" 2>&1)" || findings="${findings}tflint (${dir}):\n${out}\n\n"
      fi
    fi
  done

  # Print notice + findings (the caller folds this into the summary).
  local msg=""
  [ -n "$notice" ] && msg="$notice"
  if [ -n "$findings" ]; then
    [ -n "$msg" ] && msg="${msg}\n\n"
    msg="${msg}HCL checks reported issues:\n${findings}"
  fi
  [ -z "$msg" ] && return 0
  printf '%b' "$msg"
}
# --- eslint discovery (ported from hooks/eslint.sh) ---------------------------

# Does <package.json> declare eslint in (dev)dependencies?
kit_has_eslint_dep() {  # kit_has_eslint_dep <package.json>
  [ -f "$1" ] || return 1
  jq -e '.dependencies.eslint or .devDependencies.eslint' "$1" >/dev/null 2>&1
}

# Walk from <dir> up to <root> (inclusive) for the nearest dir holding an eslint
# config file (v9 flat or legacy). Prints the dir, or returns 1.
kit_nearest_eslint_config() {  # kit_nearest_eslint_config <dir> <root>
  local d="$1" cfg
  while :; do
    for cfg in eslint.config.js eslint.config.mjs eslint.config.cjs \
               .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml .eslintrc.yaml .eslintrc; do
      [ -f "$d/$cfg" ] && { printf '%s' "$d"; return 0; }
    done
    [ "$d" = "$2" ] && return 1
    case "$d" in "$2"/*) ;; *) return 1 ;; esac   # never walk above <root>
    [ "$d" = "/" ] && return 1
    d="${d%/*}"; [ -n "$d" ] || d="/"
  done
}

# Resolve the eslint config dir for a touched file, honoring eslint.sh's gates:
# npm prefix must exist and be within CWD; a package.json with an eslint dep must
# exist between the file dir and CWD; and a config file must exist below that.
# Prints the config dir, or returns 1 (caller skips silently).
kit_eslint_config_dir() {  # kit_eslint_config_dir <file> <cwd>
  local file_dir prefix proj cur
  file_dir="$(dirname "$1")"
  prefix="$(cd "$file_dir" 2>/dev/null && npm prefix 2>/dev/null)"
  [ -n "$prefix" ] || return 1
  case "$prefix" in "$2"|"$2"/*) ;; *) return 1 ;; esac   # within CWD only

  proj=""; cur="$file_dir"
  while :; do
    if [ -f "$cur/package.json" ] && kit_has_eslint_dep "$cur/package.json"; then
      proj="$cur"; break
    fi
    case "$cur" in "$2"|"$2"/*) ;; *) break ;; esac
    [ "$cur" = "$2" ] && break
    [ "$cur" = "/" ] && break
    cur="${cur%/*}"; [ -n "$cur" ] || cur="/"
  done
  [ -n "$proj" ] || return 1

  kit_nearest_eslint_config "$file_dir" "$proj"
}

# eslint: group touched js/ts files by resolved config dir; run `npx eslint --fix`
# once per group (cd into the config dir). Non-zero exit → collect output as a
# finding string (NEVER decision:block). Silent-skip when npx/config/dep absent.
handle_eslint() {
  [ -n "$1" ] || return 0
  command -v npx >/dev/null 2>&1 || return 0

  local cwd files f cfgdir
  cwd="$(pwd)"
  mapfile -t files <<<"$1"

  # Resolve each file's config dir ONCE (npm prefix spawns a Node process), into a
  # file→dir map; collect the unique config-dir set in the same pass.
  local -a cfgdirs=()
  declare -A file2cfg=() seen=()
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    cfgdir="$(kit_eslint_config_dir "$f" "$cwd")" || continue
    file2cfg[$f]="$cfgdir"
    [ -n "${seen[$cfgdir]:-}" ] && continue
    seen[$cfgdir]=1; cfgdirs+=("$cfgdir")
  done
  [ "${#cfgdirs[@]}" -gt 0 ] || return 0

  local findings="" out group
  for cfgdir in "${cfgdirs[@]}"; do
    group=()
    for f in "${!file2cfg[@]}"; do
      [ "${file2cfg[$f]}" = "$cfgdir" ] && group+=("$f")
    done
    [ "${#group[@]}" -gt 0 ] || continue
    if ! out="$(cd "$cfgdir" && npx eslint --fix "${group[@]}" 2>&1)"; then
      [ -n "$out" ] && findings="${findings}eslint (${cfgdir}):\n${out}\n\n"
    fi
  done

  [ -z "$findings" ] && return 0
  printf 'eslint reported issues:\n'
  printf '%b' "$findings"
}
# --- tsc discovery (ported from hooks/typescript.sh) --------------------------

# Does <package.json> declare typescript in (dev)dependencies?
kit_has_typescript_dep() {  # kit_has_typescript_dep <package.json>
  [ -f "$1" ] || return 1
  jq -e '.dependencies.typescript or .devDependencies.typescript' "$1" >/dev/null 2>&1
}

# Walk from <dir> up to <root> (inclusive) for the nearest dir holding tsconfig.json.
kit_nearest_tsconfig() {  # kit_nearest_tsconfig <dir> <root>
  local d="$1"
  while :; do
    [ -f "$d/tsconfig.json" ] && { printf '%s' "$d"; return 0; }
    [ "$d" = "$2" ] && return 1
    case "$d" in "$2"/*) ;; *) return 1 ;; esac
    [ "$d" = "/" ] && return 1
    d="${d%/*}"; [ -n "$d" ] || d="/"
  done
}

# Resolve the tsconfig dir for a touched .ts file, honoring typescript.sh's gates
# (npm prefix within CWD; package.json with typescript dep; tsconfig below it).
# Prints the tsconfig dir, or returns 1 (caller skips silently).
kit_tsc_config_dir() {  # kit_tsc_config_dir <file> <cwd>
  local file_dir prefix proj cur
  file_dir="$(dirname "$1")"
  prefix="$(cd "$file_dir" 2>/dev/null && npm prefix 2>/dev/null)"
  [ -n "$prefix" ] || return 1
  case "$prefix" in "$2"|"$2"/*) ;; *) return 1 ;; esac

  proj=""; cur="$file_dir"
  while :; do
    if [ -f "$cur/package.json" ] && kit_has_typescript_dep "$cur/package.json"; then
      proj="$cur"; break
    fi
    case "$cur" in "$2"|"$2"/*) ;; *) break ;; esac
    [ "$cur" = "$2" ] && break
    [ "$cur" = "/" ] && break
    cur="${cur%/*}"; [ -n "$cur" ] || cur="/"
  done
  [ -n "$proj" ] || return 1

  kit_nearest_tsconfig "$file_dir" "$proj"
}

# tsc: group touched .ts/.tsx by resolved tsconfig project; run `npx tsc --noEmit`
# once per project (cd into the config dir). Non-zero exit → output as a finding
# (NEVER decision:block). Silent-skip when npx/dep/tsconfig absent.
handle_tsc() {
  [ -n "$1" ] || return 0
  command -v npx >/dev/null 2>&1 || return 0

  local cwd files f cfgdir
  cwd="$(pwd)"
  mapfile -t files <<<"$1"

  local -a cfgdirs=()
  declare -A seen=()
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    cfgdir="$(kit_tsc_config_dir "$f" "$cwd")" || continue
    [ -n "${seen[$cfgdir]:-}" ] && continue
    seen[$cfgdir]=1; cfgdirs+=("$cfgdir")
  done
  [ "${#cfgdirs[@]}" -gt 0 ] || return 0

  local findings="" out
  for cfgdir in "${cfgdirs[@]}"; do
    if ! out="$(cd "$cfgdir" && npx tsc --noEmit --pretty false 2>&1)"; then
      [ -n "$out" ] && findings="${findings}tsc (${cfgdir}):\n${out}\n\n"
    fi
  done

  [ -z "$findings" ] && return 0
  printf 'tsc reported issues:\n'
  printf '%b' "$findings"
}

# Rust checks: from touched .rs/Cargo.toml, derive the unique nearest-Cargo.toml
# crate dirs; per crate run `cargo check` and `cargo clippy` once (clippy strict
# with `-D warnings` when a clippy.toml is present, matching hooks/clippy.sh).
# Findings are non-blocking. Skip silently if cargo is absent.
handle_rust_checks() {
  [ -n "$1" ] || return 0
  command -v cargo >/dev/null 2>&1 || return 0

  local files f dir crate
  mapfile -t files <<<"$1"

  # One nearest-Cargo.toml resolution per file → unique crate dir set.
  local -a crates=()
  declare -A seen=()
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    crate="$(kit_nearest_dir "$(dirname "$f")" Cargo.toml)" || continue
    [ -n "${seen[$crate]:-}" ] && continue
    seen[$crate]=1; crates+=("$crate")
  done
  [ "${#crates[@]}" -gt 0 ] || return 0

  local findings="" out
  for dir in "${crates[@]}"; do
    if ! out="$(cd "$dir" && cargo check --message-format=short 2>&1)"; then
      [ -n "$out" ] && findings="${findings}cargo check (${dir}):\n${out}\n\n"
    fi
    local clippy_args=(clippy --message-format=short)
    { [ -f "$dir/.clippy.toml" ] || [ -f "$dir/clippy.toml" ]; } && clippy_args+=(-- -D warnings)
    if ! out="$(cd "$dir" && cargo "${clippy_args[@]}" 2>&1)"; then
      [ -n "$out" ] && findings="${findings}cargo clippy (${dir}):\n${out}\n\n"
    fi
  done

  [ -z "$findings" ] && return 0
  printf 'Rust checks reported issues:\n'
  printf '%b' "$findings"
}

# Nearest ancestor dir (inclusive) whose ruff config applies: ruff.toml,
# .ruff.toml, or a pyproject.toml with a [tool.ruff] table. Prints it, or returns 1.
kit_ruff_root() {  # kit_ruff_root <dir>
  local d="$1"
  while :; do
    { [ -f "$d/ruff.toml" ] || [ -f "$d/.ruff.toml" ]; } && { printf '%s' "$d"; return 0; }
    if [ -f "$d/pyproject.toml" ] && grep -q '^\[tool\.ruff' "$d/pyproject.toml" 2>/dev/null; then
      printf '%s' "$d"; return 0
    fi
    [ "$d" = "/" ] && return 1
    d="${d%/*}"; [ -n "$d" ] || d="/"
  done
}

# Python: ruff format, then ruff check --fix (safe fixes only), once per configured
# project. Projects without a ruff config are left alone; they may use another tool.
handle_ruff() {
  [ -n "$1" ] || return 0
  local files f root ruff out findings=""
  mapfile -t files <<<"$1"
  local -a roots=()
  declare -A by_root=()
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    root="$(kit_ruff_root "$(dirname "$f")")" || continue
    [ -n "${by_root[$root]:-}" ] || roots+=("$root")
    by_root[$root]="${by_root[$root]:-}${f}"$'\n'
  done
  [ "${#roots[@]}" -gt 0 ] || return 0
  for root in "${roots[@]}"; do
    ruff="$root/.venv/bin/ruff"
    [ -x "$ruff" ] || ruff="$(command -v ruff)" || continue
    mapfile -t files <<<"${by_root[$root]%$'\n'}"
    # --force-exclude: explicit paths bypass `exclude`/`extend-exclude` unless it is set, and the
    # project excludes generated code for a reason.
    (cd "$root" && "$ruff" format --force-exclude "${files[@]}") >/dev/null 2>&1 || true
    if ! out="$(cd "$root" && "$ruff" check --fix --force-exclude --output-format concise "${files[@]}" 2>&1)"; then
      [ -n "$out" ] && findings="${findings}ruff (${root}):\n${out}\n\n"
    fi
  done
  [ -z "$findings" ] && return 0
  printf 'ruff reported issues:\n'
  printf '%b' "$findings"
}

# C and C++, only where an ancestor has .clang-format or _clang-format. Tracked files go through
# `git clang-format`, which reformats only the lines changed since HEAD so existing code keeps its
# local style. It runs once per repository with all that repository's tracked files, and with
# --force because it otherwise refuses files with unstaged changes, which an edited file always has.
# `git clang-format` is a separate executable (git-clang-format): without it, tracked files are left
# alone rather than reformatted whole, which would rewrite code the agent did not touch. Untracked
# files have no baseline, so they get `clang-format -i` on the whole file.
handle_clang_format() {
  [ -n "$1" ] || return 0
  command -v clang-format >/dev/null 2>&1 || return 0
  local files f dir top prefix repo has_gcf=""
  local -a untracked=() repos=() rfiles=()
  declare -A by_repo=()
  command -v git-clang-format >/dev/null 2>&1 && has_gcf=1
  mapfile -t files <<<"$1"
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    dir="$(dirname "$f")"
    kit_nearest_dir "$dir" .clang-format >/dev/null \
      || kit_nearest_dir "$dir" _clang-format >/dev/null || continue
    if git -C "$dir" ls-files --error-unmatch -- "$(basename "$f")" >/dev/null 2>&1; then
      [ -n "$has_gcf" ] || continue
      { IFS= read -r top; IFS= read -r prefix; } < <(git -C "$dir" rev-parse --show-toplevel --show-prefix 2>/dev/null)
      [ -n "$top" ] || continue
      [ -n "${by_repo[$top]:-}" ] || repos+=("$top")
      by_repo[$top]="${by_repo[$top]:-}${prefix}$(basename "$f")"$'\n'
    else
      untracked+=("$f")
    fi
  done
  if [ "${#repos[@]}" -gt 0 ]; then
    for repo in "${repos[@]}"; do
      mapfile -t rfiles <<<"${by_repo[$repo]%$'\n'}"
      git -C "$repo" clang-format --force --quiet -- "${rfiles[@]}" >/dev/null 2>&1 || true
    done
  fi
  [ "${#untracked[@]}" -gt 0 ] || return 0
  clang-format -i "${untracked[@]}" >/dev/null 2>&1 || true
}

findings=""
add() { [ -n "$1" ] && findings="${findings}${1}"$'\n\n'; }

# KIT_FORMAT_SKIP: space- or comma-separated handler names to skip, or "all".
kit_format_skipped() {  # kit_format_skipped <handler>
  local list=" ${KIT_FORMAT_SKIP:-} "
  list="${list//,/ }"
  case "$list" in *" all "*|*" $1 "*) return 0 ;; esac
  return 1
}

run() {  # run <handler> <glob>...
  local name="$1"; shift
  kit_format_skipped "$name" && return 0
  add "$("handle_${name}" "$(select_files "$@")")"
}

run gofmt         '*.go'
run rustfmt       '*.rs'
run hcl           '*.tf' '*.tofu' '*.tofu.json' '*.tfvars'
run eslint        '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs'
run tsc           '*.ts' '*.tsx'
run rust_checks   '*.rs' '*Cargo.toml'
run ruff          '*.py' '*.pyi'
run clang_format  '*.cpp' '*.cc' '*.cxx' '*.hpp' '*.hh' '*.hxx' '*.ipp' '*.tpp' '*.inl' '*.h'

findings="${findings%$'\n\n'}"
[ -z "$findings" ] && exit 0
printf '%s\n' "$findings"
exit 0
