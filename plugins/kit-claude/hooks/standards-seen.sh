#!/usr/bin/env bash
# Claude Code PostToolUse (Read) hook: tells the neutral standards gate which file
# the agent just read, so reading a standards file (scope, or a language's core or
# project file) stops the block for that unit.
# A ranged read (offset or limit set) shows only part of the file, so it never
# counts. The gate decides whether the path is a standards file; this file owns
# only the Claude protocol. Always silent, always exit 0.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"

# A Read payload carries the whole file in tool_response, so check the raw text
# for a standards file name before parsing anything. A false hit only costs the
# jq call below.
input="$(cat)"
case "$input" in
  *'scope.md"'*|*'core.md"'*|*'project.md"'*) ;;
  *) exit 0 ;;
esac

# One jq call reads every field; @sh quotes each value so a path with spaces,
# tabs or quotes survives the eval. Malformed JSON fails open.
fields="$(printf '%s' "$input" | jq -r '[.tool_input.file_path // "", .cwd // "", .agent_id // "", .session_id // "unknown", ((.tool_input.offset != null) or (.tool_input.limit != null))] | @sh' 2>/dev/null)" || exit 0
eval "set -- ${fields}" 2>/dev/null || exit 0
file_path="${1:-}"; cwd="${2:-}"; agent_id="${3:-}"; session_id="${4:-unknown}"; ranged="${5:-true}"
[ "$ranged" = "false" ] || exit 0
[ -n "$file_path" ] || exit 0

[ -n "$cwd" ] || cwd="$(pwd)"
case "$file_path" in
  /*) ;;
  *) file_path="${cwd%/}/${file_path}" ;;
esac

export KIT_SCRATCH_KEY="${agent_id:-$session_id}"

"${script_dir}/shared/standards-gate.sh" seen "$file_path" >/dev/null 2>&1
exit 0
