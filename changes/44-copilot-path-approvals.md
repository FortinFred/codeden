---
section: changed
---

- **Copilot's prompts for paths outside the project now show in CodeDen.** When a Copilot CLI call reaches a path outside the folders it trusts (the session's worktree, the folders it was given and the system temp), its prompt for that path used to be approved quietly by CodeDen's permission level, so a session could read further than Copilot itself allows without ever asking. It now arrives as an approval card naming the path, at every level: **Approve** allows it once, **Allow for session** stops that path asking again for the rest of the session, and **Deny** refuses it. Paths inside the worktree and the session's extra folders, and Copilot's prompts for commands, edits and MCP tools, are unchanged.
