#!/usr/bin/env bash
# Neutral SessionStart body: the using-kit governance content. Plain text on
# stdout — no JSON, no escaping; the caller (a harness-specific wrapper) embeds
# this verbatim. Takes no arguments.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
. "${script_dir}/lib.sh"

plugin_root="${KIT_PLUGIN_ROOT:?KIT_PLUGIN_ROOT is required}"

using_kit_content="$(strip_frontmatter "${plugin_root}/skills/using-kit/SKILL.md" 2>/dev/null)"
[ -n "$using_kit_content" ] || using_kit_content="Error reading using-kit skill"

cat <<EOF
<EXTREMELY_IMPORTANT>
You have kit.

**Below is the full content of your 'kit:using-kit' skill - your introduction to using skills. For all other skills, load them through your environment's skill-loading mechanism:**

${using_kit_content}

</EXTREMELY_IMPORTANT>
EOF
