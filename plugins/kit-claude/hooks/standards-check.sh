#!/usr/bin/env bash
# Claude Code PreToolUse (Edit|Write|MultiEdit) hook: asks the neutral standards
# gate whether this edit may proceed. `standards-gate.sh check` exits 2 to deny,
# with a one-line reason on stdout; any other outcome (allow, or a broken gate)
# lets the edit through. This file owns only the Claude protocol: parsing the
# hook JSON, resolving the path, keying state per agent, and the deny envelope.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"

# One jq call reads every field; @sh quotes each value so a path with spaces,
# tabs or quotes survives the eval. Malformed JSON fails open.
input="$(cat)"
fields="$(printf '%s' "$input" | jq -r '[.tool_input.file_path // "", .cwd // "", .agent_id // "", .session_id // "unknown"] | @sh' 2>/dev/null)" || exit 0
eval "set -- ${fields}" 2>/dev/null || exit 0
file_path="${1:-}"; cwd="${2:-}"; agent_id="${3:-}"; session_id="${4:-unknown}"
[ -n "$file_path" ] || exit 0

# Cheap prefilter: skip the gate for file names it can never gate. This list must
# stay in sync with the file table in gate_units_for (shared/hooks/standards-gate.sh);
# a test checks one name per pattern family.
case "${file_path##*/}" in
  *.go|go.mod|go.sum|*.rs|Cargo.toml|clippy.toml|rust-toolchain.toml) ;;
  *.tf|*.tofu|*.tofu.json|*.tfvars|*.py|*.pyi|pyproject.toml) ;;
  *.cpp|*.cc|*.cxx|*.hpp|*.hh|*.hxx|*.ipp|*.tpp|*.inl|*.h) ;;
  CMakeLists.txt|*.cmake|CMakePresets.json|.clang-tidy|.clang-format) ;;
  *.css|*.tsx|*.jsx|*.vue|*.svelte|*.astro|*.html) ;;
  *) exit 0 ;;
esac

[ -n "$cwd" ] || cwd="$(pwd)"
case "$file_path" in
  /*) ;;
  *) file_path="${cwd%/}/${file_path}" ;;
esac

# State key: agent_id when inside a subagent, else session_id (same as record.sh).
export KIT_SCRATCH_KEY="${agent_id:-$session_id}"

reason="$("${script_dir}/shared/standards-gate.sh" check "$file_path" 2>/dev/null)"
code=$?
[ "$code" -eq 2 ] || exit 0

jq -n --arg reason "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
exit 0
