#!/usr/bin/env bash
# Claude Code PostToolUse (Read) hook for the neutral standards gate. A full read of a
# standards file (scope, or a language's core or project file) marks its unit loaded. A
# read of a source file in a gated language nudges the agent, once per unit, to read the
# standards before its first edit, so the edit-time block rarely discards a finished edit.
# A ranged read never loads a unit; a ranged read of a source file still nudges.
# This file owns only the Claude protocol. Always exit 0; stdout is the nudge envelope or empty.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"

# A Read payload carries the whole file in tool_response, so check the raw text for a
# standards or gated file name before parsing anything. A false hit only costs the jq
# call below. The gated names must stay in sync with gate_units_for in
# shared/hooks/standards-gate.sh; a test checks one name per pattern family.
input="$(cat)"
case "$input" in
  *'scope.md"'*|*'core.md"'*|*'project.md"'*) ;;
  *'.go"'*|*'go.mod"'*|*'go.sum"'*|*'.rs"'*|*'Cargo.toml"'*|*'clippy.toml"'*|*'rust-toolchain.toml"'*) ;;
  *'.tf"'*|*'.tofu"'*|*'.tofu.json"'*|*'.tfvars"'*|*'.py"'*|*'.pyi"'*|*'pyproject.toml"'*) ;;
  *'.cpp"'*|*'.cc"'*|*'.cxx"'*|*'.hpp"'*|*'.hh"'*|*'.hxx"'*|*'.ipp"'*|*'.tpp"'*|*'.inl"'*|*'.h"'*) ;;
  *'CMakeLists.txt"'*|*'.cmake"'*|*'CMakePresets.json"'*|*'.clang-tidy"'*|*'.clang-format"'*) ;;
  *'.css"'*|*'.tsx"'*|*'.jsx"'*|*'.vue"'*|*'.svelte"'*|*'.astro"'*|*'.html"'*) ;;
  *) exit 0 ;;
esac

# One jq call reads every field; @sh quotes each value so a path with spaces,
# tabs or quotes survives the eval. Malformed JSON fails open.
fields="$(printf '%s' "$input" | jq -r '[.tool_input.file_path // "", .cwd // "", .agent_id // "", .session_id // "unknown", ((.tool_input.offset != null) or (.tool_input.limit != null))] | @sh' 2>/dev/null)" || exit 0
eval "set -- ${fields}" 2>/dev/null || exit 0
file_path="${1:-}"; cwd="${2:-}"; agent_id="${3:-}"; session_id="${4:-unknown}"; ranged="${5:-true}"
[ -n "$file_path" ] || exit 0

[ -n "$cwd" ] || cwd="$(pwd)"
case "$file_path" in
  /*) ;;
  *) file_path="${cwd%/}/${file_path}" ;;
esac

export KIT_SCRATCH_KEY="${agent_id:-$session_id}"
gate="${script_dir}/shared/standards-gate.sh"

case "${file_path##*/}" in
  scope.md|core.md|project.md)
    [ "$ranged" = "false" ] && "$gate" seen "$file_path" >/dev/null 2>&1
    exit 0 ;;
esac

nudge="$("$gate" nudge "$file_path" 2>/dev/null)" || exit 0
[ -n "$nudge" ] || exit 0
jq -n --arg context "$nudge" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $context}}'
exit 0
