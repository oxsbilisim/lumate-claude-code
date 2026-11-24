---
description: Make this Claude Code session your main one in Lumate (the one Lumate's requests go to); "off" takes it back
argument-hint: [off]
allowed-tools: Bash(sh "${CLAUDE_PLUGIN_ROOT}/scripts/main.sh":*)
---

Mark this session as my main Claude Code session in Lumate. Run exactly this command, once, and show me its one-line result:

```
sh "${CLAUDE_PLUGIN_ROOT}/scripts/main.sh" "$ARGUMENTS"
```

Only one session of mine is main: marking this one unmarks the other. Lumate sends its requests (what did I do today, a question) to
the main session, and waits for it when it is closed; it never sends them to another session of mine. Helper sessions (started with
`LUMATE_SESSION_ROLE=helper`) cannot be main.
