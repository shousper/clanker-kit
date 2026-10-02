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

input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
[ -n "$file_path" ] || exit 0

cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
[ -n "$cwd" ] || cwd="$(pwd)"
case "$file_path" in
  /*) ;;
  *) file_path="${cwd%/}/${file_path}" ;;
esac

# State key: agent_id when inside a subagent, else session_id (same as record.sh).
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // ""')"
session_id="$(printf '%s' "$input" | jq -r '.session_id // "unknown"')"
export KIT_SCRATCH_KEY="${agent_id:-$session_id}"

reason="$("${script_dir}/shared/standards-gate.sh" check "$file_path" 2>/dev/null)"
code=$?
[ "$code" -eq 2 ] || exit 0

jq -n --arg reason "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
exit 0
