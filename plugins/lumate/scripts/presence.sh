#!/bin/sh
# SessionStart ("start"), SessionEnd ("end"), UserPromptSubmit ("turn": a turn began) and Stop ("idle": it ended): tells Lumate this session is running, busy or over. Sends the session id (Lumate keeps only a
# hash of it), the repository NAME, the branch and a hash of the project folder: never a path. The role is "helper" when LUMATE_SESSION_ROLE=helper (an agent another
# session drives: Lumate never asks it anything), else "person". Fails quiet. Needs the project's .lumate.env or LUMATE_URL/LUMATE_TOKEN.
event=${1:-beat}
input=$(cat 2>/dev/null)
here=$(cd "$(dirname "$0")" && pwd) || exit 0
. "$here/lib.sh" || exit 0
sid=$(lumate_session_id "$input")
[ -n "$sid" ] || exit 0
lumate_setup "$input"
lumate_ready || exit 0
max=3; [ "$event" = "end" ] && max=1
lumate_post "/api/connector/sessions/presence" "$(printf '{"session_id":"%s","event":"%s","repo":"%s","branch":"%s","role":"%s","root":"%s"}' "$sid" "$event" "$(lumate_repo "$LUMATE_ROOT")" "$(lumate_branch "$LUMATE_ROOT")" "$(lumate_role)" "$(lumate_root_key "$LUMATE_ROOT")")" "$max"
exit 0
