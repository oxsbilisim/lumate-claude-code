#!/bin/sh
# The waiter (SessionStart and Stop, as an asyncRewake hook): holds a long poll on Lumate and, when Lumate has a request for this
# session, exits with code 2 and the fenced request on stderr, which wakes Claude even when the session is idle. One waiter per
# session (a lock folder keyed by the session id); a second start exits at once. Gives up quietly 60 seconds before the hook's own
# time limit, when the key is refused, or when Lumate stays unreachable. Needs the project's .lumate.env or LUMATE_URL/LUMATE_TOKEN.
input=$(cat 2>/dev/null)
here=$(cd "$(dirname "$0")" && pwd) || exit 0
. "$here/lib.sh" || exit 0
sid=$(lumate_session_id "$input")
[ -n "$sid" ] || exit 0
lumate_setup "$input"
lumate_ready || exit 0
dir=$(lumate_state_dir) || exit 0
lock="$dir/waiter-$sid.lock"
if ! mkdir "$lock" 2>/dev/null; then
  pid=$(cat "$lock/pid" 2>/dev/null)
  # a waiter is running for this session: its process is alive and is really a waiter (a reused pid is not)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q 'wait\.sh'; then exit 0; fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || exit 0
fi
printf '%s' "$$" >"$lock/pid"
trap 'rm -rf "$lock"' EXIT
trap 'exit 0' INT TERM HUP
budget=${LUMATE_WAIT_BUDGET:-21540}   # the hook's timeout is 21600
poll=${LUMATE_WAIT_SECONDS:-50}
retry=${LUMATE_WAIT_RETRY:-30}
start=$(date +%s)
fails=0
while :; do
  t0=$(date +%s)
  left=$((budget - (t0 - start)))
  [ "$left" -gt 0 ] || exit 0
  n=$poll; [ "$left" -lt "$n" ] && n=$left
  if text=$(lumate_get "/api/connector/sessions/wait?session_id=$sid&role=$(lumate_role)&timeout=$n" $((n + 10))); then
    fails=0
    text=$(printf '%s' "$text" | lumate_clean)
    if [ -n "$text" ]; then lumate_note_requests "$sid" "$text"; printf '%s\n' "$text" | lumate_wrap >&2; exit 2; fi
    [ $(($(date +%s) - t0)) -ge 1 ] || sleep 1   # an answer that came at once is not polled in a hot loop
  else
    fails=$((fails + 1))
    [ "$fails" -lt 10 ] || exit 0
    sleep "$retry"
  fi
done
