#!/usr/bin/env bash
# Formats/checks exactly the files given as arguments, via the per-extension
# handler table below (single source of the whole kit formatter pipeline — do
# not duplicate this table elsewhere). Prints a plain-text summary of anything
# a handler reports (a first-detection notice, or non-blocking lint/check
# findings); silent + exit 0 on a clean run. Exits 0 regardless of individual
# formatter/checker failures — this NEVER blocks the caller.
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
findings=""
add() { [ -n "$1" ] && findings="${findings}${1}"$'\n\n'; }

# cargo check, clippy, and tsc --noEmit are project compiles. A hook budget
# cannot finish them, and a killed compile is not a finding, so they are not
# hook work.
add "$(handle_gofmt       "$(select_files '*.go')")"
add "$(handle_rustfmt     "$(select_files '*.rs')")"
add "$(handle_hcl         "$(select_files '*.tf' '*.tofu' '*.tofu.json' '*.tfvars')")"
add "$(handle_eslint      "$(select_files '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs')")"

findings="${findings%$'\n\n'}"
[ -z "$findings" ] && exit 0
printf '%s\n' "$findings"
exit 0
