---
section: fixed
---

- **Draft pull requests settle cleanly.** Marking a draft ready now replaces its "mark it ready" note with the queue's own message instead of leaving the stale note behind. A pull request converted back to a draft resolves its "Ready to merge" inbox item with that reason, and announces it afresh if it is marked ready again.
- **`factory_allow_large_change` accepts a draft.** A project manager can allow an oversized change whose pull request is still a draft, so the size-failed work is no longer blocked on someone marking it ready first.
