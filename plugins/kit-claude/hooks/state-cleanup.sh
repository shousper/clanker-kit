#!/usr/bin/env bash
# Claude Code SessionStart + SessionEnd hook: maps the event onto the shared
# state cleanup (shared/state-cleanup.sh).
#   SessionStart (any source): prune
#   SessionEnd with reason "clear": forget this session's state, because /clear
#     starts a new session_id and drops the context the state described
# Any other event or reason does nothing. Silent, always exit 0 (fail-open).
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"

event="" session_id="" reason=""
IFS=$'\x1f' read -r event session_id reason < <(
  jq -r '[(.hook_event_name // ""), (.session_id // ""), (.reason // "")] | map(tostring) | join("\u001f")' 2>/dev/null
) || true

case "$event" in
  SessionStart)
    "${script_dir}/shared/state-cleanup.sh" prune >/dev/null 2>&1
    ;;
  SessionEnd)
    if [ "$reason" = "clear" ]; then
      KIT_SCRATCH_KEY="$session_id" "${script_dir}/shared/state-cleanup.sh" forget >/dev/null 2>&1
    fi
    ;;
esac
exit 0
