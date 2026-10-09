#!/usr/bin/env bash
# Neutral helpers shared by every kit hook script, across harnesses. Sourced,
# never executed directly. No top-level side effects. Plain args/env in,
# plain text out — no stdin JSON, no harness protocol of any kind.
#
# The formatter/checker table (gofmt, rustfmt, hcl, eslint, tsc, cargo, ruff,
# clang-format) lives in format-files.sh, not here — that is its single source.

kit_state_dir() {  # KIT_STATE_DIR wins outright; else ~/.kit/state. Each harness's
  printf '%s' "${KIT_STATE_DIR:-$HOME/.kit/state}"   # protocol wrapper sets KIT_STATE_DIR.
}

# Per-agent/session scratch file for touched-file tracking. The caller resolves
# and exports KIT_SCRATCH_KEY (agent_id when inside a subagent, else session_id
# — a harness/protocol decision, made by the wrapper that owns that payload).
kit_scratch_file() {
  printf '%s/touched-%s.txt' "$(kit_state_dir)" "${KIT_SCRATCH_KEY:?KIT_SCRATCH_KEY required}"
}

# Gate at record time: is this a source path we format/check?
kit_is_handled() {  # kit_is_handled <path>
  case "$1" in
    */Cargo.toml|Cargo.toml) return 0 ;;
    *.go|*.rs|*.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.tf|*.tofu|*.tofu.json|*.tfvars) return 0 ;;
    *.py|*.pyi|*.cpp|*.cc|*.cxx|*.hpp|*.hh|*.hxx|*.ipp|*.tpp|*.inl|*.h) return 0 ;;
    *) return 1 ;;
  esac
}

# Nearest ancestor dir (inclusive) containing <marker>; prints dir, or returns 1.
kit_nearest_dir() {  # kit_nearest_dir <start-dir> <marker>
  local d="$1"
  while :; do
    [ -e "$d/$2" ] && { printf '%s' "$d"; return 0; }
    [ "$d" = "/" ] && return 1
    d="${d%/*}"; [ -n "$d" ] || d="/"
  done
}

# Physical absolute path of an existing file: every symlink (in the directory
# part and the file itself, relative or absolute) resolved. Prints the path, or
# returns 1 when <file> is not an existing file. Does not need GNU realpath.
kit_physical_path() {  # kit_physical_path <file>
  local p="${1:-}" dir target hops=0 linkdir
  [ -n "$p" ] || return 1
  while [ -L "$p" ]; do
    hops=$((hops + 1)); [ "$hops" -le 40 ] || return 1   # symlink loop
    target="$(readlink "$p")" || return 1
    case "$p" in */*) linkdir="${p%/*}" ;; *) linkdir="." ;; esac
    case "$target" in
      /*) p="$target" ;;
      *) p="${linkdir}/$target" ;;   # relative to the link's directory
    esac
  done
  [ -f "$p" ] || return 1
  dir="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  [ "$dir" = "/" ] && dir=""
  printf '%s/%s' "$dir" "${p##*/}"
}

# Drop a leading YAML frontmatter block (--- ... ---) from a markdown file, if
# present; print the rest unchanged. No-op when the file doesn't start with one.
strip_frontmatter() {  # strip_frontmatter <file>
  awk '
    NR==1 && $0=="---" { infm=1; next }
    infm && $0=="---" { infm=0; next }
    infm { next }
    { print }
  ' "$1"
}
