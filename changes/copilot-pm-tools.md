---
section: fixed
---

- **A Copilot CLI PM can use `start_session` again.** Copilot's tool search could keep CodeDen's tools out of the model's first tool set on the models that support it, so a project manager on Copilot reported that it had no `start_session` while the same PM on another provider did. CodeDen now passes its MCP server to Copilot as a per-session `--additional-mcp-config` entry with `deferTools: "never"` and its tools' long-call timeout, so CodeDen's tools are always loaded. `start_session`'s `conflict` argument is a flat object now too, which every provider's MCP client accepts, with the same wait/skip/join/force behaviour.
