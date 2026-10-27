#!/usr/bin/env bash
# Kit state cleanup (neutral, no harness protocol). Owns the lifetime of the
# state files in $(kit_state_dir): standards-<key>.txt (standards gate state)
# and touched-<key>.txt (formatter scratch).
#
#   state-cleanup.sh prune    delete state files 48 hours old or older. This is
#                             the only cleanup for sessions that end any other
#                             way, because a resumed session keeps its context
#                             (so its gate state must survive) and subagent keys
#                             are unknown when a session ends.
#   state-cleanup.sh forget   delete this agent's two files at once, for when the
#                             context they described is gone (Claude /clear, OMP
#                             /new). Does nothing when KIT_SCRATCH_KEY is empty
#                             or contains "/".
#
# Env: KIT_SCRATCH_KEY (agent key, forget only), KIT_STATE_DIR (via kit_state_dir).
# Silent and always exit 0 (a missing state directory is fine), except exit 64
# for an unknown subcommand.
# Bash 3.2 compatible (macOS /bin/bash): no mapfile, associative arrays, or ${x,,}.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
. "${script_dir}/lib.sh" 2>/dev/null || exit 0

cleanup_prune() {
  local state_dir
  state_dir="$(kit_state_dir)"
  [ -d "$state_dir" ] || return 0
  # -H follows a symlinked state dir (KIT_STATE_DIR may be one); -maxdepth 1
  # leaves subdirectories alone. -mtime +1 matches files whose age rounds down
  # to 2 days or more, that is 48 hours or older, not "over one day".
  find -H "$state_dir" -maxdepth 1 -type f \( -name 'touched-*.txt' -o -name 'standards-*.txt' \) -mtime +1 -delete 2>/dev/null || true
}

cleanup_forget() {
  local key="${KIT_SCRATCH_KEY:-}" state_dir
  [ -n "$key" ] || return 0
  case "$key" in */*) return 0 ;; esac
  state_dir="$(kit_state_dir)"
  rm -f -- "${state_dir}/standards-${key}.txt" "${state_dir}/touched-${key}.txt" 2>/dev/null || true
}

case "${1:-}" in
  prune) cleanup_prune ;;
  forget) cleanup_forget ;;
  *) echo "usage: state-cleanup.sh {prune|forget}" >&2; exit 64 ;;
esac
exit 0
