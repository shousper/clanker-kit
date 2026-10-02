#!/usr/bin/env bash
# Claude Code PostToolUse (Read) hook: tells the neutral standards gate which file
# the agent just read, so reading a language's standards file stops the block.
# A ranged read (offset or limit set) shows only part of the file, so it never
# counts. The gate decides whether the path is a standards file; this file owns
# only the Claude protocol. Always silent, always exit 0.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"

input="$(cat)"
ranged="$(printf '%s' "$input" | jq -r '((.tool_input.offset != null) or (.tool_input.limit != null))')"
[ "$ranged" = "false" ] || exit 0

file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
[ -n "$file_path" ] || exit 0

cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
[ -n "$cwd" ] || cwd="$(pwd)"
case "$file_path" in
  /*) ;;
  *) file_path="${cwd%/}/${file_path}" ;;
esac

agent_id="$(printf '%s' "$input" | jq -r '.agent_id // ""')"
session_id="$(printf '%s' "$input" | jq -r '.session_id // "unknown"')"
export KIT_SCRATCH_KEY="${agent_id:-$session_id}"

"${script_dir}/shared/standards-gate.sh" seen "$file_path" >/dev/null 2>&1
exit 0
