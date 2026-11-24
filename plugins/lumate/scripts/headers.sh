#!/bin/sh
# headersHelper of the plugin's MCP server: prints {"Authorization": "Bearer <key>"} as JSON for the project folder the session was
# opened in (the .lumate.env of its root), else for the older LUMATE_TOKEN of the environment; {} when there is no key. The key is
# printed only to Claude Code (which runs this), never to a log. $1 is ${CLAUDE_PROJECT_DIR}.
here=$(cd "$(dirname "$0")" && pwd) || { printf '{}'; exit 0; }
. "$here/lib.sh" || { printf '{}'; exit 0; }
root=$(lumate_root "${1:-${CLAUDE_PROJECT_DIR:-$PWD}}") && lumate_load_env "$root" || :
case ${LUMATE_TOKEN:-} in '' | *[!A-Za-z0-9._~-]*) printf '{}'; exit 0 ;; esac
printf '{"Authorization": "Bearer %s"}' "$LUMATE_TOKEN"
