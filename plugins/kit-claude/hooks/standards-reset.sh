#!/usr/bin/env bash
# Claude Code SessionStart (clear|compact) hook: returns every language to
# "unseen" for this agent key, because the standards text a read put into
# context is gone after /clear or compaction. The matcher in hooks.json decides
# when this runs. SessionStart fires on the main thread, so the key is the
# session_id. Silent, always exit 0.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"

input="$(cat)"
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // ""')"
session_id="$(printf '%s' "$input" | jq -r '.session_id // "unknown"')"
export KIT_SCRATCH_KEY="${agent_id:-$session_id}"

"${script_dir}/shared/standards-gate.sh" reset >/dev/null 2>&1
exit 0
