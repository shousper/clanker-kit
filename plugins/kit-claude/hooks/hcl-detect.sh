#!/usr/bin/env bash
# Claude Code SessionStart hook: one-time per-project notice naming the
# detected HCL tool. Silent unless the project tracks HCL AND no decision is
# cached yet. Detection/caching/atomic-claim logic is entirely in the neutral,
# unchanged shared/hcl-tool.sh; this file owns only the Claude protocol.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export KIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${script_dir}/.." && pwd)}"
export KIT_STATE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/state"
# shellcheck source=shared/lib.sh disable=SC1091
. "${script_dir}/shared/lib.sh"

input="$(cat)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
[ -n "$cwd" ] || cwd="$(pwd)"

hcl_tool="${script_dir}/shared/hcl-tool.sh"

# Prune scratch and standards-gate state left by dead sessions/agents
# (within-session scratch leftovers self-heal on the next Stop; a pruned gate
# state only means one more block for a session idle over a day). Runs
# regardless of cwd, before the early-exits.
state_dir="$(kit_state_dir)"
if [ -d "$state_dir" ]; then
  find "$state_dir" \( -name 'touched-*.txt' -o -name 'standards-*.txt' \) -mtime +1 -delete 2>/dev/null || true
fi

# Already decided? stay silent.
[ -n "$("$hcl_tool" get "$cwd")" ] && exit 0
# Not an HCL project? stay silent.
"$hcl_tool" is-hcl "$cwd" || exit 0

# Atomically claim the first detection; only the winner notifies (avoids a
# duplicate notice if a SubagentStop hook races this at session start).
tool="$("$hcl_tool" first-detect "$cwd")"
[ -n "$tool" ] || exit 0
other="terraform"; [ "$tool" = "terraform" ] && other="tofu"
jq -n --arg m "Detected ${tool} for this project. Override with /kit:hcl-tool ${other}." \
  '{systemMessage:$m}'
exit 0
