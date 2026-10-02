#!/usr/bin/env bash
# Standards gate (neutral, no harness protocol). Blocks an agent's first edit in
# a language until the agent has read that language's standards file, and
# blocks at most once per language per agent.
#
#   standards-gate.sh check FILE   exit 0 = allow; exit 2 = block, reason on stdout
#   standards-gate.sh seen FILE    FILE was read; mark its language loaded if it is a standards file
#   standards-gate.sh reset        forget every language for this agent
#
# Env: KIT_PLUGIN_ROOT (standards live in $KIT_PLUGIN_ROOT/code-standards/<lang>/CLAUDE.md),
#      KIT_SCRATCH_KEY (agent key), KIT_STATE_DIR (via kit_state_dir).
# FILE is absolute; the harness wrappers resolve relative paths first.
#
# Any internal failure allows the edit: a kit defect must never stall an agent.
# Bash 3.2 compatible (macOS /bin/bash): no mapfile, associative arrays, or ${x,,}.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
. "${script_dir}/lib.sh"

gate_label() {  # gate_label <lang>
  case "$1" in
    go) printf 'Go' ;;
    rust) printf 'Rust' ;;
    hcl) printf 'HCL (Terraform/OpenTofu)' ;;
    tailwindcss) printf 'Tailwind CSS' ;;
  esac
}

gate_standards_path() { printf '%s/code-standards/%s/CLAUDE.md' "$KIT_PLUGIN_ROOT" "$1"; }

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

# Language of an absolute file path; prints the lang id, or returns 1.
gate_lang_for() {  # gate_lang_for <abs-file>
  case "${1##*/}" in
    *.go|go.mod|go.sum) printf 'go' ;;
    *.rs|Cargo.toml) printf 'rust' ;;
    *.tf|*.tofu|*.tofu.json|*.tfvars) printf 'hcl' ;;
    *.css|*.tsx|*.jsx|*.vue|*.svelte|*.astro|*.html)
      gate_has_tailwind "$1" || return 1
      printf 'tailwindcss' ;;
    *) return 1 ;;
  esac
}

gate_state_file() { printf '%s/standards-%s.txt' "$(kit_state_dir)" "$KIT_SCRATCH_KEY"; }

# Last recorded state for <lang> (prompted|loaded); prints nothing when none.
gate_last_state() {  # gate_last_state <lang>
  local f; f="$(gate_state_file)"
  [ -f "$f" ] || return 0
  awk -v lang="$1" '$1 == lang { state = $2 } END { if (state != "") print state }' "$f"
}

gate_record() {  # gate_record <lang> <prompted|loaded>
  mkdir -p "$(kit_state_dir)" 2>/dev/null || return 1
  printf '%s %s\n' "$1" "$2" >> "$(gate_state_file)" 2>/dev/null
}

cmd_check() {  # cmd_check <abs-file>; 0 = allow, 2 = block
  local file="${1:-}" lang sp label reason tool
  case "$file" in /*) ;; *) return 0 ;; esac
  lang="$(gate_lang_for "$file")" || return 0
  sp="$(gate_standards_path "$lang")"
  [ -f "$sp" ] || return 0
  [ -z "$(gate_last_state "$lang")" ] || return 0
  gate_record "$lang" prompted || return 0   # can't remember the block, so don't block
  label="$(gate_label "$lang")"
  reason="kit: before editing ${file}, read the ${label} standards in full at ${sp} and follow them for all ${label} code in this session, then retry this edit. kit asks once per language per session."
  if [ "$lang" = hcl ]; then
    tool="$("${script_dir}/hcl-tool.sh" resolve "$(dirname "$file")" 2>/dev/null | tr -d '[:space:]')"
    [ -z "$tool" ] || reason="${reason} This project uses ${tool}."
  fi
  printf '%s\n' "$reason"
  return 2
}

# Runs after every Read, so the basename test comes first and costs nothing.
cmd_seen() {  # cmd_seen <file>; marks the language loaded when <file> is its standards file
  local file="${1:-}" phys lang sp sp_phys
  file="${file%:raw}"
  [ "${file##*/}" = "CLAUDE.md" ] || return 0
  phys="$(kit_physical_path "$file")" || return 0
  for lang in go rust hcl tailwindcss; do
    sp="$(gate_standards_path "$lang")"
    sp_phys="$(kit_physical_path "$sp")" || continue
    [ "$phys" = "$sp_phys" ] || continue
    [ "$(gate_last_state "$lang")" = loaded ] || gate_record "$lang" loaded
  done
  return 0
}

cmd_reset() { rm -f "$(gate_state_file)"; }

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
