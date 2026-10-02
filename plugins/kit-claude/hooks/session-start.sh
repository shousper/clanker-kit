#!/usr/bin/env bash
# Claude Code SessionStart hook: wraps the neutral session-context body in
# Claude's hookSpecificOutput/additionalContext JSON. All governance content
# lives in shared/session-context.sh; this file owns only the Claude protocol.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"

body="$("${script_dir}/shared/session-context.sh")"

# Escape string for JSON embedding using bash parameter substitution.
# Each ${s//old/new} is a single C-level pass - orders of magnitude
# faster than the character-by-character loop this replaces.
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

body_escaped="$(escape_for_json "$body")"

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${body_escaped}"
  }
}
EOF

exit 0
