---
section: fixed
---

- **Copilot CLI approvals no longer vanish.** Every permission request Copilot CLI sends now reaches CodeDen: a policy decision for ordinary calls, an approval card for anything your level escalates. A request that arrives while no turn is running (a background subagent, or work that outlived the prompt) opens its own turn so its card is shown, and a subagent's ask is titled **Subagent:** so it isn't mistaken for the main agent's.
- **A turn no longer ends silently when Copilot asks.** Copilot CLI records a cancelled or failed permission request as a user denial and ends the (sub)agent's turn without a message. CodeDen now always answers with an option Copilot offered — including its "always" option when that is all it offers — and says so in the transcript when it can't answer at all. A call CodeDen approved can still be refused or sandboxed by Copilot's own rules.
- **One decision can cover a repeated safe call.** The approval card's **Always allowed this session** now also keys URL requests by URL, so approving one page for the session never approves every other host.
