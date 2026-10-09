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
