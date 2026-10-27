#!/usr/bin/env bash
# Standards gate (neutral, no harness protocol). Blocks an agent's first edit in
# a language until the agent has read the standards units that apply, and
# blocks at most once per unit per agent. A unit is one standards file:
#   scope             $KIT_PLUGIN_ROOT/code-standards/scope.md
#   <lang>            $KIT_PLUGIN_ROOT/code-standards/<lang>/core.md
#   <lang>:project    $KIT_PLUGIN_ROOT/code-standards/<lang>/project.md
# One block names every unread unit the file needs, in the order scope, core, project.
#
#   standards-gate.sh check FILE   exit 0 = allow; exit 2 = block, reason on stdout
#   standards-gate.sh seen FILE    FILE was read; mark its unit loaded if it is a standards file
#   standards-gate.sh reset        forget every unit for this agent
#
# Env: KIT_PLUGIN_ROOT (standards root, see above),
#      KIT_SCRATCH_KEY (agent key), KIT_STATE_DIR (via kit_state_dir).
# FILE is absolute; the harness wrappers resolve relative paths first.
#
# State file, one line per event: "<unit> prompted|loaded", and "cpp-root yes|no ROOT"
# caching whether a repository root holds a C++ source (ROOT last: it can hold spaces).
#
# A unit whose file does not exist is skipped, and a language without core.md is not gated.
# Any internal failure allows the edit: a kit defect must never stall an agent.
# Bash 3.2 compatible (macOS /bin/bash): no mapfile, associative arrays, or ${x,,}.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
. "${script_dir}/lib.sh"

# Helpers that return a string set a global instead of printing it, so the hot
# path forks nothing: REPLY, GATE_LANG and GATE_UNITS.
gate_label() {  # gate_label <lang>: sets REPLY
  case "$1" in
    go) REPLY='Go' ;;
    rust) REPLY='Rust' ;;
    hcl) REPLY='HCL (Terraform/OpenTofu)' ;;
    tailwindcss) REPLY='Tailwind CSS' ;;
    python) REPLY='Python' ;;
    cpp) REPLY='C++' ;;
    *) REPLY='' ;;
  esac
}

gate_unit_path() {  # gate_unit_path <unit>: sets REPLY
  case "$1" in
    scope) REPLY="$KIT_PLUGIN_ROOT/code-standards/scope.md" ;;
    *:project) REPLY="$KIT_PLUGIN_ROOT/code-standards/${1%:project}/project.md" ;;
    *) REPLY="$KIT_PLUGIN_ROOT/code-standards/$1/core.md" ;;
  esac
}

# Unit of a standards file path under $KIT_PLUGIN_ROOT/code-standards: sets REPLY, or returns 1.
gate_unit_of() {  # gate_unit_of <path>
  local rel="${1#"$KIT_PLUGIN_ROOT"/code-standards/}"
  case "$rel" in
    scope.md) REPLY='scope' ;;
    */core.md) REPLY="${rel%/core.md}" ;;
    */project.md) REPLY="${rel%/project.md}:project" ;;
    *) return 1 ;;
  esac
}

# Physical path of an existing directory, without a trailing slash ("" for /): sets REPLY.
# Leaves the working directory as it found it.
gate_physical_dir() {  # gate_physical_dir <dir>
  local start="$PWD"
  cd -P -- "$1" >/dev/null 2>&1 || return 1
  REPLY="$PWD"
  [ "$REPLY" != "/" ] || REPLY=""
  cd -- "$start" >/dev/null 2>&1 || true
  return 0
}

# The state file is read once per invocation, on first use. It fills:
#   GATE_DIR, GATE_FILE   state directory and this agent's file
#   GATE_ANY              " unit unit ... " every unit with a recorded state
#   GATE_LOADED           " unit unit ... " every unit recorded loaded
#   GATE_CPP_YES/_NO      newline-delimited repository roots cached as holding / not holding C++
# A unit is never prompted after it is loaded, so "loaded" needs no ordering. A root
# recorded both ways (a race between two scans) counts as C++.
GATE_READY=""
GATE_DIR=""
GATE_FILE=""
GATE_ANY=" "
GATE_LOADED=" "
GATE_CPP_YES=$'\n'
GATE_CPP_NO=$'\n'
gate_load() {
  [ -z "$GATE_READY" ] || return 0
  GATE_READY=1
  GATE_DIR="$(kit_state_dir)"
  GATE_FILE="${GATE_DIR}/standards-${KIT_SCRATCH_KEY}.txt"
  [ -f "$GATE_FILE" ] || return 0
  local line unit rest state
  while IFS= read -r line || [ -n "$line" ]; do
    rest="${line#* }"
    [ "$rest" != "$line" ] || continue
    unit="${line%% *}"
    state="${rest%% *}"
    case "$unit" in
      cpp-root)
        case "$state" in
          yes) GATE_CPP_YES="${GATE_CPP_YES}${rest#* }"$'\n' ;;
          no) GATE_CPP_NO="${GATE_CPP_NO}${rest#* }"$'\n' ;;
        esac ;;
      *)
        GATE_ANY="${GATE_ANY}${unit} "
        [ "$state" != loaded ] || GATE_LOADED="${GATE_LOADED}${unit} " ;;
    esac
  done < "$GATE_FILE"
}

# Appends lines (each ending in a newline) to the state file in one write; returns 1 when it can't.
gate_append() {  # gate_append <lines>
  mkdir -p "$GATE_DIR" 2>/dev/null && printf '%s' "$1" >> "$GATE_FILE" 2>/dev/null
}

# Tailwind applies only inside a project that uses it: some ancestor directory
# (up to / inclusive) has a tailwind.config.* file or a package.json that
# mentions "tailwindcss".
gate_has_tailwind() {  # gate_has_tailwind <abs-file>
  local d="${1%/*}" cfg
  [ -n "$d" ] || d="/"
  while :; do
    for cfg in tailwind.config.js tailwind.config.cjs tailwind.config.mjs tailwind.config.ts; do
      [ -f "$d/$cfg" ] && return 0
    done
    if [ -f "$d/package.json" ] && grep -q '"tailwindcss"' "$d/package.json" 2>/dev/null; then
      return 0
    fi
    [ "$d" = "/" ] && return 1
    d="${d%/*}"; [ -n "$d" ] || d="/"
  done
}

# C and C++ share some files. They count as C++ only when the repository holds a
# C++ source: the nearest ancestor with .git, or else the directory of the file.
# Like git, the search never climbs into a GIT_CEILING_DIRECTORIES entry.
# The answer is cached per repository root in the agent's state file.
gate_has_cpp() {  # gate_has_cpp <abs-file>
  local dir="${1%/*}" parent root found=no
  [ -n "$dir" ] || dir="/"
  root="$dir"
  while :; do
    if [ -e "$dir/.git" ]; then root="$dir"; break; fi
    [ "$dir" = "/" ] && break
    parent="${dir%/*}"; [ -n "$parent" ] || parent="/"
    case ":${GIT_CEILING_DIRECTORIES:-}:" in *":$parent:"*) break ;; esac
    dir="$parent"
  done
  gate_load
  case "$GATE_CPP_YES" in *$'\n'"$root"$'\n'*) return 0 ;; esac
  case "$GATE_CPP_NO" in *$'\n'"$root"$'\n'*) return 1 ;; esac
  if [ -n "$(find "$root" -maxdepth 5 \
      \( -name .git -o -name node_modules -o -name vendor -o -name third_party \
         -o -name build -o -name 'cmake-build-*' \) -prune \
      -o -type f \( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' \
         -o -name '*.hpp' -o -name '*.hh' -o -name '*.hxx' \) -print -quit 2>/dev/null)" ]; then
    found=yes
  fi
  gate_append "cpp-root ${found} ${root}"$'\n' || true
  [ "$found" = yes ]
}

# C++ for a header C and C++ share: any C++ state for this agent, or a C++ source in the repository.
gate_is_cpp() {  # gate_is_cpp <abs-file>
  gate_load
  case "$GATE_ANY" in *" cpp "*) return 0 ;; esac
  gate_has_cpp "$1"
}

# Units an absolute file path needs: sets GATE_LANG, and GATE_UNITS as "scope <lang>"
# plus " <lang>:project" for build and tool config; returns 1 when no language applies.
gate_units_for() {  # gate_units_for <abs-file>
  local lang facet=""
  case "${1##*/}" in
    *.go|go.mod|go.sum) lang=go ;;
    Cargo.toml|clippy.toml|rust-toolchain.toml) lang=rust; facet=project ;;
    *.rs) lang=rust ;;
    *.tf|*.tofu|*.tofu.json|*.tfvars) lang=hcl ;;
    pyproject.toml) lang=python; facet=project ;;
    *.py|*.pyi) lang=python ;;
    *.cpp|*.cc|*.cxx|*.hpp|*.hh|*.hxx|*.ipp|*.tpp|*.inl) lang=cpp ;;
    CMakeLists.txt|*.cmake|CMakePresets.json|.clang-tidy|.clang-format)
      # Adds the cpp:project unit, so C++ state from another repository must not decide this one.
      gate_has_cpp "$1" || return 1
      lang=cpp; facet=project ;;
    *.h) gate_is_cpp "$1" || return 1; lang=cpp ;;
    *.css|*.tsx|*.jsx|*.vue|*.svelte|*.astro|*.html)
      gate_has_tailwind "$1" || return 1
      lang=tailwindcss ;;
    *) return 1 ;;
  esac
  GATE_LANG="$lang"
  GATE_UNITS="scope ${lang}"
  [ -z "$facet" ] || GATE_UNITS="${GATE_UNITS} ${lang}:${facet}"
}

cmd_check() {  # cmd_check <abs-file>; 0 = allow, 2 = block
  local file="${1:-}" unit lines="" pending=0 paths="" label reason tool
  case "$file" in /*) ;; *) return 0 ;; esac
  gate_units_for "$file" || return 0
  gate_unit_path "$GATE_LANG"
  [ -f "$REPLY" ] || return 0   # an ungated language never asks for scope
  gate_load
  for unit in $GATE_UNITS; do
    gate_unit_path "$unit"
    [ -f "$REPLY" ] || continue
    case "$GATE_ANY" in *" $unit "*) continue ;; esac
    pending=1
    lines="${lines}${unit} prompted"$'\n'
    paths="${paths:+${paths}, }${REPLY}"
  done
  [ "$pending" = 1 ] || return 0
  gate_append "$lines" || return 0   # can't remember the block, so don't block
  gate_label "$GATE_LANG"; label="$REPLY"
  reason="kit: before editing ${file}, read these standards in full and follow them for all ${label} code in this session, then retry this edit: ${paths}. kit asks once per standards file per session."
  if [ "$GATE_LANG" = hcl ]; then
    tool="$("${script_dir}/hcl-tool.sh" resolve "$(dirname "$file")" 2>/dev/null | tr -d '[:space:]')"
    [ -z "$tool" ] || reason="${reason} This project uses ${tool}."
  fi
  printf '%s\n' "$reason"
  return 2
}

# Runs after every Read, so the basename test comes first and costs nothing. The
# read file and the standards directory are resolved once, and a candidate is
# compared by string unless it is, or sits in, a symlink.
cmd_seen() {  # cmd_seen <file>; marks a unit loaded when <file> is its standards file
  local file="${1:-}" dir phys std_phys sp rel expect unit linked lines=""
  file="${file%:raw}"
  case "${file##*/}" in scope.md|core.md|project.md) ;; *) return 0 ;; esac
  [ -f "$file" ] || return 0
  if [ -L "$file" ]; then
    phys="$(kit_physical_path "$file")" || return 0
  else
    case "$file" in */*) dir="${file%/*}"; [ -n "$dir" ] || dir="/" ;; *) dir="." ;; esac
    gate_physical_dir "$dir" || return 0
    phys="${REPLY}/${file##*/}"
  fi
  gate_physical_dir "$KIT_PLUGIN_ROOT/code-standards" || return 0
  std_phys="$REPLY"
  for sp in "$KIT_PLUGIN_ROOT/code-standards/scope.md" \
            "$KIT_PLUGIN_ROOT"/code-standards/*/core.md \
            "$KIT_PLUGIN_ROOT"/code-standards/*/project.md; do
    [ -f "$sp" ] || continue
    rel="${sp#"$KIT_PLUGIN_ROOT"/code-standards/}"
    linked=""
    [ ! -L "$sp" ] || linked=1
    case "$rel" in */*) [ ! -L "${sp%/*}" ] || linked=1 ;; esac
    if [ -n "$linked" ]; then
      expect="$(kit_physical_path "$sp")" || continue
    else
      [ "${rel##*/}" = "${phys##*/}" ] || continue
      expect="${std_phys}/${rel}"
    fi
    [ "$phys" = "$expect" ] || continue
    gate_unit_of "$sp" || continue
    unit="$REPLY"
    gate_load
    case "$GATE_LOADED" in *" $unit "*) continue ;; esac
    lines="${lines}${unit} loaded"$'\n'
  done
  [ -z "$lines" ] || gate_append "$lines" || true
  return 0
}

cmd_reset() {
  gate_load
  rm -f "$GATE_FILE"
}

main() {
  local sub="${1:-}"
  case "$sub" in
    check|seen|reset) ;;
    *) echo "usage: standards-gate.sh {check FILE|seen FILE|reset}" >&2; return 64 ;;
  esac
  [ -n "${KIT_PLUGIN_ROOT:-}" ] && [ -n "${KIT_SCRATCH_KEY:-}" ] || return 0
  case "$sub" in
    check) cmd_check "${2:-}" ;;
    seen) cmd_seen "${2:-}" ;;
    reset) cmd_reset ;;
  esac
}

main "$@"
