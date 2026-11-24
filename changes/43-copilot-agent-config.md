---
section: added
---

- **Copilot CLI memory, skills and custom agents.** The Agents page now lists and edits Copilot CLI's own files alongside Claude's and Codex's: `~/.copilot/copilot-instructions.md` and `~/.copilot/instructions/**/*.instructions.md`; the repository's `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` (nested ones included); skills in `~/.copilot/skills`, `~/.agents/skills`, `.github/skills`, `.claude/skills` and `.agents/skills`; and custom agents in `~/.copilot/agents` and `.github/agents`. New skills and agents go to those folders, and a session's What's loaded view shows what Copilot reads from its working directory. Copilot skills are listed without an on/off switch for now, and its MCP servers and hooks are not edited yet.
