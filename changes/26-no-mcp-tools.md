---
section: added
---

- **CodeDen's tools without MCP.** When a company policy disables MCP servers (notably for Copilot CLI), **Settings → Providers** can give that provider's sessions the same CodeDen tools through a local `codeden-tools` skill and a small bridge script instead of an MCP server. The agent runs the script, which calls CodeDen's loopback tool endpoint with a session-only token passed in its environment, so progress reporting, questions, finishing, the browser, GitHub and factory tools keep working. The plugin folder lives in the temporary directory and is removed when the session closes; your own MCP servers are unaffected, and other providers keep using MCP.
