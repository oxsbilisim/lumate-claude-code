#!/bin/sh
# PreToolUse: while a colleague's question or report request is open in this session (a marker written when it was delivered, cleared by
# lumate_reply or after 15 minutes) the session may only READ, by a strict allowlist; every other tool is denied:
#   Read (the path is checked), Glob and Grep (path and glob checked; Grep names or counts only), Bash limited to plain read-only git
#   commands that print no file content (or only a checked path), the lumate_reply tool, and TodoWrite/Skill/ToolSearch (loading lumate_reply). No shell, no quotes or
#   globs, no secret-like path. The owner's own work requests set no marker. No network. Never blocks when no request is open.
# Fails closed: once a request is open, any internal error denies (and hooks.json sets onFailure "block", so a crash blocks too).
input=$(cat 2>/dev/null)
here=$(cd "$(dirname "$0")" && pwd) || exit 0
. "$here/lib.sh" || exit 0
sid=$(lumate_session_id "$input")
[ -n "$sid" ] || exit 0
lumate_marked "$sid" || exit 0

decided=
allow() { decided=1; exit 0; }
fault() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "A colleague's question is open and the read-only check failed, so nothing is allowed until you call lumate_reply (load it with the tool search if needed), or 15 minutes pass."; }
trap '[ -n "$decided" ] || fault' EXIT
[ -z "${LUMATE_GUARD_FAULT:-}" ] || exit 7   # (tests: an internal failure)

deny() {
  decided=1
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
    "A colleague's question is being answered through Lumate, so this session is read-only until you call lumate_reply (load it with the tool search if it is not loaded yet; or 15 minutes pass): $1. If the answer needs a change, say so in the reply instead."
  exit 0
}

# field <name>: a plain string value of the tool input (no escapes: an escaped value is not checked, so it is denied by the callers).
field() { printf '%s' "$input" | sed -n "s/.*\"$1\" *: *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
has_escape() { case $1 in *\\*) return 0 ;; esac; return 1; }

cwd=$(lumate_cwd "$input")
project=$(cd "$cwd" 2>/dev/null && pwd -P) || deny "the project folder could not be found"
lower() { printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'; }

# secret_name <one path segment>: file names that hold secrets (already lower-cased).
secret_name() {
  case $1 in
    .env* | *.env | *.env.* | .lumate* | *.pem | *.key | *.p12 | *.keystore | id_rsa* | id_dsa* | id_ecdsa* | id_ed25519* | .npmrc | .netrc | .pypirc | credentials* | secrets* | service_account*.json | .git | .ssh | .aws) return 0 ;;
  esac
  return 1
}
# secret_in <path or argument>: any segment of it (split on / and :) is a secret name.
secret_in() {
  rest=$(lower "$1")
  old=$IFS; IFS='/:'
  set -f
  # shellcheck disable=SC2086
  set -- $rest
  IFS=$old
  for seg in "$@"; do secret_name "$seg" && return 0; done
  return 1
}

# checked_path <path>: allowed only inside the project, no link, no secret name (case-insensitive, after resolving the folder).
checked_path() {
  p=$1
  [ -n "$p" ] || return 0
  has_escape "$p" && deny "that path could not be checked"
  case $p in *'~'* | *'$'* | *'*'* | *'?'* | *'['*) deny "that path is not a plain path inside the project" ;; esac
  case $p in /*) ;; *) p="$project/$p" ;; esac
  if [ -d "$p" ]; then
    full=$(cd "$p" 2>/dev/null && pwd -P) || deny "that path could not be resolved"   # a folder, a trailing .. or . included, is resolved whole
    [ ! -L "${p%/}" ] || deny "links are not followed"
  else
    d=${p%/*}; b=${p##*/}
    case $b in .. | .) deny "that path could not be resolved" ;; esac
    [ -n "$d" ] || d=/
    d=$(cd "$d" 2>/dev/null && pwd -P) || deny "that path could not be resolved"
    full="$d/$b"
    [ ! -L "$full" ] || deny "links are not followed"
  fi
  case "$(lower "$full")/" in "$(lower "$project")"/*) ;; *) deny "only files inside the project are read" ;; esac
  secret_in "$full" && deny "secret files are not read"
  return 0
}

# checked_pattern <glob>: no .., no ~, and an absolute pattern only inside the project.
checked_pattern() {
  pat=$1
  [ -n "$pat" ] || return 0
  has_escape "$pat" && deny "that pattern could not be checked"
  case $pat in *..* | '~'*) deny "patterns may not leave the project" ;; esac
  case $pat in
    /*) case "$(lower "$pat")" in "$(lower "$project")"/* | "$(lower "$cwd")"/*) ;; *) deny "patterns may not leave the project" ;; esac ;;
  esac
  return 0
}

# git_path_ok <path in the repository>: a plain relative path, no .., no secret-like segment.
git_path_ok() {
  case $1 in /* | '~'* | *..* | *'*'* | *'?'* | *'['*) return 1 ;; esac
  secret_in "$1" && return 1
  return 0
}
# commit_ok <ref>: names a commit or tag (never a blob or a tree), so no file content can come out of it by its name.
commit_ok() {
  r=${1#^}
  [ -n "$r" ] || return 1
  case $(git -C "$project" cat-file -t "$r" 2>/dev/null) in commit | tag) return 0 ;; esac
  return 1
}
# range_ok <a..b | a...b | a>: every side of a range names a commit.
range_ok() {
  parts=$(printf '%s' "$1" | sed -e 's/\.\.\./ /' -e 's/\.\./ /')
  for part in $parts; do commit_ok "$part" || return 1; done
  return 0
}

tool=$(lumate_tool_name "$input")
case $tool in
  mcp__plugin_lumate_lumate__lumate_reply | TodoWrite | Skill | ToolSearch) allow ;;   # ToolSearch only loads a tool's schema (runs nothing); a tool it loads is checked here when called
  Read)
    path=$(field file_path); [ -n "$path" ] || deny "that read could not be checked"
    checked_path "$path"; allow ;;
  Glob)
    checked_path "$(field path)"; checked_pattern "$(field pattern)"; allow ;;
  Grep)
    mode=$(field output_mode)
    case $mode in '' | files_with_matches | count) ;; *) deny "searches show file names or counts only, not content" ;; esac
    checked_path "$(field path)"; checked_pattern "$(field glob)"; allow ;;
  Bash) ;;
  *) deny "$tool is not allowed" ;;
esac

# Bash: one plain git read. Every word is plain characters; no quotes, globs, spaces inside, $, backslashes, ; & | < > ( ) { } `.
cmd=$(field command)
[ -n "$cmd" ] || deny "that command could not be checked"
has_escape "$cmd" && deny "that command could not be checked"
set -f
# shellcheck disable=SC2086
set -- $cmd
[ "$1" = git ] || deny "only git reads are allowed"
shift
for arg in "$@"; do
  case $arg in *[!A-Za-z0-9_./:=@^~,+-]*) deny "arguments may only hold plain characters" ;; esac
  case $arg in --output* | --ext-diff | --textconv | --exec* | -O* | --open-files-in-pager* | --no-index | --git-dir* | --work-tree* | -c | -C) deny "that git option can run or write" ;; esac
  secret_in "$arg" && deny "secret files are not read"
done
sub=${1:-}
case $sub in -* | '') deny "no git option may come before the command" ;; esac
shift
case $sub in
  rev-parse) allow ;;
  status)
    for arg in "$@"; do case $arg in -s | --short | -b | --branch | --porcelain) ;; *) deny "git status only lists (no diffs)" ;; esac; done
    allow ;;
  branch)
    for arg in "$@"; do case $arg in --list | -a | --all | -r | --remotes | -v | -vv | --show-current) ;; *) deny "git branch only lists" ;; esac; done
    allow ;;
  log | show | diff | blame | shortlog) ;;
  *) deny "that git command is not on the read-only list (log, show, diff, status, branch, blame, shortlog, rev-parse)" ;;
esac
# log/show/diff/blame/shortlog: no patch, raw or blob output. Content comes out only for a path that passes the secret check.
after=; safe=; paths=0; revs=0; revpaths=0; files=0
for arg in "$@"; do
  if [ -n "$after" ]; then git_path_ok "$arg" || deny "that path is not readable"; paths=$((paths + 1)); continue; fi
  case $arg in
    --) after=1 ;;
    --stat | --stat=* | --name-only | --name-status | --shortstat | --numstat | --summary | --no-patch | -s) safe=1 ;;
    --oneline | --format=* | --pretty=* | -n | -n[0-9]* | -[0-9]* | --max-count=* | --since=* | --until=* | --after=* | --before=* | --author=* | --committer=* | --grep=* | --all | --no-merges | --graph | --decorate | --abbrev-commit | --first-parent | --reverse | --date=*) ;;
    -sn | -ns | -e | -se | -ne) [ "$sub" = shortlog ] || deny "that git option is not allowed" ;;
    -*) deny "that git option is not allowed (patches and raw output are not shown)" ;;
    *[!0-9]*:*)
      commit_ok "${arg%%:*}" || deny "that revision is not a commit"
      git_path_ok "${arg#*:}" || deny "that path is not readable"
      revpaths=$((revpaths + 1)) ;;
    *)
      case $arg in *[!0-9]*) ;; *) continue ;; esac   # a number: the value of -n
      if [ "$sub" = blame ]; then
        if range_ok "$arg"; then revs=$((revs + 1)); else git_path_ok "$arg" || deny "that path is not readable"; files=$((files + 1)); fi
      elif range_ok "$arg"; then revs=$((revs + 1))
      elif [ "$sub" = log ] || [ "$sub" = shortlog ]; then git_path_ok "$arg" || deny "that path is not readable"
      else deny "that revision is not a commit (name paths after --)"
      fi ;;
  esac
done
[ "$sub" != blame ] || [ $((files + paths)) -ge 1 ] || deny "git blame needs a file"
if [ "$sub" = show ] || [ "$sub" = diff ]; then
  if [ -z "$safe" ]; then
    # it prints content: only for explicit checked paths (after --, or rev:path alone), never a whole commit or diff
    if [ "$paths" -ge 1 ] && [ "$revpaths" -eq 0 ]; then :
    elif [ "$revpaths" -ge 1 ] && [ "$revs" -eq 0 ] && [ "$paths" -eq 0 ]; then :
    else deny "that command would print file content: add --stat or --name-only, or limit it to a path after --"; fi
  fi
fi
allow
