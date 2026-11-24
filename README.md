# Lumate for Claude Code

Lumate is a company assistant that your team talks to. This plugin connects your Claude Code sessions to your own
Lumate: Claude can report what it did, and Lumate can pass on questions from your colleagues.

## Install

```sh
claude plugin marketplace add oxsbilisim/lumate-claude-code
claude plugin install lumate@lumate
```

Restart Claude Code. The plugin asks once for your Lumate address (for example `https://lumate.example.com`).

## Connect

Open your project's page in Lumate and choose **Connect to Claude Code** (or go to **Settings → My connections**). Lumate gives you a
prompt to paste into Claude Code in the project folder. It writes the project's key to `.lumate.env` in that folder (added to
`.gitignore` when the project is a git repository; mode 600) and nothing else. Alternatively, set `LUMATE_URL` and `LUMATE_TOKEN` in your environment; they are used when no
`.lumate.env` is found. You can also connect with `/lumate-link <address> <code>`, the line the dialog shows.

## What it adds

- Tools: `lumate_report`, `lumate_questions`, `lumate_answer`, `lumate_ask`, `lumate_my_tasks`, `lumate_reply`.
- `/lumate-report` sends a short report of the session. An automatic report once per session is available with `LUMATE_AUTO_REPORT=1`.
- `/lumate-main` marks a session as your main one; `LUMATE_SESSION_ROLE=helper` makes a session that another agent drives a helper,
  which Lumate never asks anything.
- `/lumate-link <address> <code>` connects a project with the line shown in Lumate's dialog.
- Waiting questions are shown at session start and after your prompts, each once. These come only with the personal `LUMATE_URL` and
  `LUMATE_TOKEN` (a project's key cannot read them).
- While a colleague's question is open, the session is read-only: Claude can read and search the project but not change it. This ends
  when Claude answers with `lumate_reply`, or after 15 minutes.

## What it sends and keeps open

- Presence (session start and end) sends your Lumate server the session id, the repository's name, the branch and the role
  (person or helper). Never a path.
- At session start and after each prompt, it fetches waiting questions (sends only your token; personal `LUMATE_URL`/`LUMATE_TOKEN` only).
- The request check after each prompt, and the wait, send the session id and role. After tool calls the check runs at most once a minute.
- With `LUMATE_AUTO_REPORT=1`, stopping a session that changed files makes one check call to your Lumate server.
- A background wait keeps one long poll open per session (up to 6 hours), re-armed after each answer.
- `/lumate-main` posts this session's id. `/lumate-link` redeems a one-time code.
- Beyond these calls to your Lumate server, nothing leaves your computer except what you or Claude send through the tools and commands.

The hook scripts never print your key and say nothing when Lumate is unreachable.

## Requirements

`sh` and `curl`. On Windows, Git Bash.

## Check it

```sh
sh test/smoke.sh
claude plugin validate .
claude plugin validate plugins/lumate
```

For setup details, see Lumate's guide, *Connect Claude Code*.

## Licence

MIT, see [LICENSE](LICENSE).
