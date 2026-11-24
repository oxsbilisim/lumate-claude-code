#!/bin/sh
# /lumate-main [off]: makes THIS session your main Claude Code session in Lumate (the one Lumate's requests go to; marking one unmarks the
# other), or with "off" takes the mark away. Sends only the session id (Lumate keeps a hash). Prints one line; never the key.
# The session id is the first argument, else Claude Code's own CLAUDE_CODE_SESSION_ID (the id the hooks' JSON session_id carries); the
# first argument may also be just on / off.
case ${1:-} in on | off) mode=$1; sid=${CLAUDE_CODE_SESSION_ID:-} ;; *) sid=${1:-${CLAUDE_CODE_SESSION_ID:-}}; mode=${2:-on} ;; esac
here=$(cd "$(dirname "$0")" && pwd) || exit 1
. "$here/lib.sh" || exit 1
case $sid in '' | *[!A-Za-z0-9_-]*) echo "Lumate: this session's id is not available, so it cannot be marked."; exit 1 ;; esac
case $mode in on) main=true ;; off) main=false ;; *) echo "Lumate: use /lumate-main, or /lumate-main off."; exit 1 ;; esac
if [ "$main" = true ] && [ "$(lumate_role)" = helper ]; then echo "Lumate: this is a helper session (LUMATE_SESSION_ROLE=helper); only your own session can be main."; exit 1; fi
lumate_setup ""
lumate_ready || { echo "Lumate: not set up here (no .lumate.env or LUMATE_URL / LUMATE_TOKEN), so nothing was changed."; exit 1; }
if lumate_post "/api/connector/sessions/main" "$(printf '{"session_id":"%s","main":%s}' "$sid" "$main")" 8; then
  if [ "$main" = true ]; then echo "Lumate: this is now your main Claude Code session. Requests from Lumate come here; any other main session was unmarked."
  else echo "Lumate: this session is no longer your main one."; fi
else
  echo "Lumate refused: this session has not been seen by Lumate yet (try again in a moment), it is a helper session, or Lumate is not reachable."; exit 1
fi
