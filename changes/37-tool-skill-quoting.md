---
section: security
---

- **The `codeden-tools` skill no longer turns relayed text into shell.** When a provider's company policy blocks MCP, the agent runs CodeDen's tools through a bridge script, and the skill told it to pass the JSON arguments as a single-quoted shell word. Text the agent relays from an issue, a comment, a PR title or a question can contain an apostrophe, and one `'` ended the quoting: the rest of the text ran as shell, so prompt-injected content could execute commands on the machine. The skill now documents a quoted heredoc (`node "<script>" <tool> <<'CODEDEN_JSON'` … `CODEDEN_JSON`), the bridge reads the JSON object from standard input, and the shell performs no expansion, so those characters arrive at the tool unchanged.
