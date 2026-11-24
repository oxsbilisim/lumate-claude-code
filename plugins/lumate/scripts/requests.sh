#!/bin/sh
# UserPromptSubmit and PostToolUse: counts as a beat (the person is working) and carries the requests Lumate has for this session as
# context. `requests.sh prompt` prints text; `requests.sh tool` prints PostToolUse's JSON, at most once a minute (a stamp file).
# The text is already fenced by Lumate as data; it is cleaned again here. Fails quiet.
mode=${1:-prompt}
input=$(cat 2>/dev/null)
here=$(cd "$(dirname "$0")" && pwd) || exit 0
. "$here/lib.sh" || exit 0
sid=$(lumate_session_id "$input")
[ -n "$sid" ] || exit 0
lumate_setup "$input"
lumate_ready || exit 0
dir=$(lumate_state_dir) || exit 0
if [ "$mode" = "tool" ]; then
  case $(lumate_tool_name "$input") in *lumate_reply) lumate_unmark "$sid" ;; esac   # the answer is sent: the session is free again
  stamp="$dir/requests-$sid.stamp"
  now=$(date +%s)
  last=$(cat "$stamp" 2>/dev/null)
  case $last in '' | *[!0-9]*) last=0 ;; esac
  [ $((now - last)) -ge "${LUMATE_TOOL_EVERY:-60}" ] || exit 0
  printf '%s' "$now" >"$stamp" 2>/dev/null
fi
text=$(lumate_get "/api/connector/sessions/requests?session_id=$sid&role=$(lumate_role)" 4) || exit 0
text=$(printf '%s' "$text" | lumate_clean)
[ -n "$text" ] || exit 0
lumate_note_requests "$sid" "$text"
text=$(printf '%s\n' "$text" | lumate_wrap)
if [ "$mode" = "tool" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$(printf '%s' "$text" | lumate_json_escape)"
else
  printf '%s\n' "$text"
fi
exit 0
