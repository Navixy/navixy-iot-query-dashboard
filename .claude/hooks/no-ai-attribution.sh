#!/usr/bin/env bash
# PreToolUse guard: keep AI-attribution trailers out of commit messages, PR/MR
# descriptions and PR/MR comments.
#
# Matches LINE-INITIAL markers only. That is the whole design: a git trailer and
# the Claude Code footer are line-initial by definition, while a review finding
# that *quotes* the string does so inline and backticked ("… `Co-Authored-By:
# Claude` trailer in commit abc123 …"). So the guard blocks the violation and
# still lets a review report it.
#
# Reads the PreToolUse payload on stdin; denies by printing permissionDecision.
set -uo pipefail

text=$(jq -r '
  [ .tool_input.command?, .tool_input.content?, .tool_input.new_string? ]
  | map(select(type == "string")) | join("\n")
' 2>/dev/null) || exit 0

[ -n "$text" ] || exit 0

# 1. git trailer:  Co-Authored-By: Claude ... / Co-authored-by: Claude ...
# 2. PR footer:    🤖 Generated with [Claude Code](...)  — the leading
#    [^A-Za-z0-9]* eats the emoji and its space without needing to match UTF-8.
if printf '%s\n' "$text" | grep -qiE \
  -e '^[[:space:]]*Co-Authored-By:.*Claude' \
  -e '^[^A-Za-z0-9]*Generated with \[?Claude Code'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"AI-attribution trailer blocked. This repo forbids a line-initial `Co-Authored-By: Claude ...` trailer or a `Generated with [Claude Code]` footer in commit messages, PR/MR descriptions and PR/MR comments — see CLAUDE.md. Drop that line and retry. Quoting the string inline (backticked, mid-sentence) is allowed and is how a review reports the violation."}}
JSON
fi
exit 0
