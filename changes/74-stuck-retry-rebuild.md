---
section: fixed
---

- **Stuck factory work rebuilds when the PM retries it.** `factory_retry_item` without a mode now starts a stuck item over from its first step instead of sending its pull request back to a review that can only fail again, and an explicit re-review of stuck work is refused with the reason. Unstuck work with an open pull request still re-reviews it by default.
