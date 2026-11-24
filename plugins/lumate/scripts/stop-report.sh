#!/bin/sh
# Stop hook, opt-in (LUMATE_AUTO_REPORT=1): once per session, when the session changed files, hold the stop once and ask
# Claude to call lumate_report first. A flag file per session id (in the person's own 0700 folder) makes it a one-time block,
# so it can never loop. Cheap checks first, the one network call last. Fails quiet: any doubt means "let the developer stop".
[ "${LUMATE_AUTO_REPORT:-}" = "1" ] || { cat >/dev/null 2>&1; exit 0; }
input=$(cat 2>/dev/null)
here=$(cd "$(dirname "$0")" && pwd) || exit 0
. "$here/lib.sh" || exit 0
sid=$(lumate_session_id "$input")
[ -n "$sid" ] || exit 0
lumate_setup "$input"
lumate_ready || exit 0
dir=$(lumate_state_dir) || exit 0
flag="$dir/$sid.reported"
[ ! -e "$flag" ] || exit 0
transcript=$(printf '%s' "$input" | sed -n 's/.*"transcript_path" *: *"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0
# Only a session that changed files is worth a report.
grep -Eq '"name" *: *"(Edit|Write|MultiEdit|NotebookEdit)"' "$transcript" 2>/dev/null || exit 0
# Already reported by hand (/lumate-report or the tool): nothing to ask for.
if grep -Eq '"name" *: *"[A-Za-z0-9_]*lumate_report"' "$transcript" 2>/dev/null; then : >"$flag" 2>/dev/null; exit 0; fi
# Lumate has to be reachable: otherwise there is nobody to report to, and the developer is never held up.
lumate_get "/api/connector/me" 3 >/dev/null || exit 0
: >"$flag" 2>/dev/null || exit 0
printf '%s\n' '{"decision":"block","reason":"Before you stop: send a short report of this session to my Lumate with the lumate_report tool (two to six plain sentences: what was asked, what changed, what is left; no code, no secrets). Then finish."}'
exit 0
