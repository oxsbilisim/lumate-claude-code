---
description: Hand a task to your Lumate (it does it and answers in your conversation)
---

Give my Lumate this task with the `lumate_request` tool, in plain words: $ARGUMENTS

- Say what is wanted and for whom, as I would say it to Lumate in the app. No code, passwords, keys or tokens.
- Attach files only if I named them, with their paths inside this project folder (`files`); the plugin uploads them.
- Anything that reaches people outside my company waits for my click in Lumate (Approvals): tell me when that is the case.
- Afterwards, call `lumate_request_result` with the id to tell me what Lumate answered (or that it is still working).
