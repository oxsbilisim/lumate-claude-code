---
description: Connect this project folder to Lumate with the line from the project's "Connect to Claude Code" dialog
argument-hint: <address> <code>
allowed-tools: Bash(sh:*)
---

Connect this project to Lumate. Run exactly this command, once, and show me its one-line result. Do not read, print or commit
`.lumate.env`; it holds this project's key.

```
sh "${CLAUDE_PLUGIN_ROOT}/scripts/link.sh" $ARGUMENTS
```

If it says the connection worked, tell me to run `/reload-plugins` (or `/mcp` and reconnect the lumate server) so the key is used.
