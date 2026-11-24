#!/bin/sh
# /lumate-link <address> <code>: redeems the one-time code of a project's "connect Claude Code" dialog and writes the project's key to
# .lumate.env in the project's folder (its git root if it is a git repository; mode 600, added to .gitignore only in a git repository). The key goes from curl straight into the file: this script
# prints only whether it worked, never the key. The code is an argument, never part of a URL.
address=$1
code=$2
here=$(cd "$(dirname "$0")" && pwd) || exit 1
. "$here/lib.sh" || exit 1
case $code in '' | *[!A-Za-z0-9_-]*) echo "Lumate: that code is not valid. Use the whole line from the project's dialog: /lumate-link <address> <code>"; exit 1 ;; esac
LUMATE_URL=${address%/}; LUMATE_TOKEN=x
lumate_ready || { echo "Lumate: the address is not usable (https only, or this computer)."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Lumate: curl is needed."; exit 1; }
root=$(lumate_root "${CLAUDE_PROJECT_DIR:-$PWD}") || { echo "Lumate: open Claude Code inside the project's folder."; exit 1; }
file="$root/.lumate.env"
if command -v git >/dev/null 2>&1 && git -C "$root" ls-files --error-unmatch .lumate.env >/dev/null 2>&1; then
  echo "Lumate: .lumate.env is tracked by git. Run git rm --cached .lumate.env first, then try again."; exit 1
fi
tmp="$file.tmp.$$"
( umask 077
  curl -sS --fail --connect-timeout 5 --max-time 20 --max-filesize 4096 -X POST --data-urlencode "code=$code" -o "$tmp" "${address%/}/api/connector/link" 2>/dev/null ) || { rm -f "$tmp"; echo "Lumate: the code was refused (used already, expired, or not yours). Press the button in Lumate again."; exit 1; }
# exactly the three expected lines, in plain characters: anything else is not Lumate's answer
if [ "$(wc -l <"$tmp" | tr -d ' ')" != 3 ] || [ "$(sed -n '1p' "$tmp" | cut -d= -f1)" != LUMATE_URL ] || [ "$(sed -n '2p' "$tmp" | cut -d= -f1)" != LUMATE_TOKEN ] \
   || [ "$(sed -n '3p' "$tmp" | cut -d= -f1)" != LUMATE_PROJECT ] || grep -q '[^A-Za-z0-9_=:./~-]' "$tmp"; then
  rm -f "$tmp"; echo "Lumate: the answer was not what Lumate sends, so nothing was saved."; exit 1
fi
chmod 600 "$tmp" && mv "$tmp" "$file" || { rm -f "$tmp"; echo "Lumate: could not write .lumate.env."; exit 1; }
if [ -e "$root/.git" ]; then
  ignore="$root/.gitignore"
  if ! grep -qx '.lumate.env' "$ignore" 2>/dev/null; then printf '%s\n' '.lumate.env' >>"$ignore"; fi
  echo "Lumate: this project is connected (key saved in .lumate.env, which git ignores). Run /reload-plugins so Claude Code picks the key up."
else
  echo "Lumate: this project is connected (key saved in .lumate.env, private to you). Run /reload-plugins so Claude Code picks the key up."
fi
