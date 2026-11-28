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

- Tools: `lumate_report`, `lumate_request`, `lumate_request_result`, `lumate_questions`, `lumate_answer`, `lumate_ask`, `lumate_my_tasks`, `lumate_reply`.
- **Give Lumate a task** (`lumate_request`): "prepare a test sheet for Can, give it to Lumate, and Lumate sends it to Can on WhatsApp". Your
  words arrive in your private conversation with Lumate as if you had typed them there (marked "from your Claude Code"), and Lumate does the
  work with your own rights. `lumate_request_result(id)` shows what Lumate answered, or that it is still working. Use `lumate_report` to
  only *tell* Lumate what you did (it does nothing); use `lumate_request` when you want something *done*, and only when you asked for it.
  - Actions inside the team (a task, a note, a routine, a message to a teammate) go straight through. Anything that reaches **outside the
    company** (a customer, outside e-mail, a call to an outsider, a payment, publishing) first waits for your click on a card in Lumate →
    Approvals, because a Claude Code session may have read text somebody else wrote.
  - Files: list paths **inside the project folder** (up to 10, 25 MB each). The plugin uploads them itself; files outside the folder, links,
    and secret files (`.env*`, `.lumate*`, keys, certificates, `.git`, ...) are refused, and no path is sent, only the file name.
  - It needs a key of yours with the "request" permission (on by default; switch it off per key in Settings → My connections). A project's
    key (the `.lumate.env` of **Connect to Claude Code**) is still *your* key: the request goes to your private conversation, with the
    project named in the "from your Claude Code (<project>)" line. Only the answer to *this* request is returned by `lumate_request_result`.
- `/lumate-report` sends a short report of the session. An automatic report once per session is available with `LUMATE_AUTO_REPORT=1`.
- `/lumate-main` marks a session as your main one; `LUMATE_SESSION_ROLE=helper` makes a session that another agent drives a helper,
  which Lumate never asks anything.
- `/lumate-link <address> <code>` connects a project with the line shown in Lumate's dialog.
- Waiting questions are shown at session start and after your prompts, each once. These come only with the personal `LUMATE_URL` and
  `LUMATE_TOKEN` (a project's key cannot read them).
- While a colleague's question is open, the session is read-only: Claude can read and search the project but not change it. This ends
  when Claude answers with `lumate_reply`, or after 15 minutes.

## Survives server restarts

The tools reach Lumate through a small proxy the plugin starts (`scripts/mcp-proxy.js`, Node, no packages). While your Lumate restarts
(a deploy, one to two minutes), the proxy waits and retries each call for up to three minutes (a tool call is repeated only if it certainly never reached Lumate; if the connection drops during one, you get "check whether it was done" instead), so the tools stay in your session: no
`/mcp` reconnect and no Claude Code restart. If Lumate is still away after that, the call answers "Lumate is restarting or unreachable;
try again in a minute" and the next call works as soon as it is back. If Lumate is down when the session opens, the tools appear when
it is back. A key that is missing or expired gives a clear message pointing to the Connect dialog; a new key in `.lumate.env` is used by
the very next call. It writes no files (an optional debug log, `LUMATE_PROXY_DEBUG=<file>`, is off by default and holds no key or text).

## What it sends and keeps open

- Presence (session start and end) sends your Lumate server the session id, the repository's name, the branch and the role
  (person or helper). Never a path.
- At session start and after each prompt, it fetches waiting questions (sends only your token; personal `LUMATE_URL`/`LUMATE_TOKEN` only).
- The request check after each prompt, and the wait, send the session id and role. After tool calls the check runs at most once a minute.
- With `LUMATE_AUTO_REPORT=1`, stopping a session that changed files makes one check call to your Lumate server.
- A background wait keeps one long poll open per session (up to 6 hours), re-armed after each answer.
- `/lumate-main` posts this session's id. `/lumate-link` redeems a one-time code.
- The tools' calls go to `<your address>/mcp` with your key, through the proxy above.
- Beyond these calls to your Lumate server, nothing leaves your computer except what you or Claude send through the tools and commands.

The hook scripts never print your key and say nothing when Lumate is unreachable.

## Requirements

`sh` and `curl` for the hooks, and `node` (18 or newer) on the PATH for the tools. On Windows, Git Bash.

## Check it

```sh
sh test/smoke.sh
node --test test/*.test.js      # the proxy, against a fake server (about 10 seconds)
claude plugin validate .
claude plugin validate plugins/lumate
```

For setup details, see Lumate's guide, *Connect Claude Code*.

## Checking that the tools survive a deploy (manual)

1. Update the plugin (`claude plugin update lumate@lumate`), then restart Claude Code once (this one time only). In `/mcp`, `lumate`
   shows as connected and its tools are listed.
2. Deploy Lumate. While it is restarting, ask Claude to call `lumate_questions`: it waits instead of failing, and answers when the
   server is back (or, after three minutes, with "Lumate is restarting or unreachable").
3. After the deploy, `/mcp` still shows `lumate` connected, and the tools are still there. No reconnect.

## Licence

MIT, see [LICENSE](LICENSE).
