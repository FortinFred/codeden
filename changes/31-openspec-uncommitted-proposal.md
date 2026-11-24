---
section: fixed
---

- **An uncommitted OpenSpec change reaches its builder.** The factory reads `openspec/changes/` from the project's main checkout, while a builder works in a worktree branched from the default branch, so a change written by hand or by the OpenSpec CLI and not committed yet wasn't there. The brief no longer promises the proposal is already present: it tells the builder to write `proposal.md` from the item's title and request when the worktree doesn't have it, and to keep it when it does, so the change folder still travels in the pull request.
