---
section: fixed
---

- **A PM or orchestrator at its provider limit no longer drains its queue.** When the role's turn failed on a usage limit or a transient provider failure, the old session was marked failed and its queue was delivered one message at a time, each starting another turn that failed the same way: the role looked busy for a long time and the operator saw a stuck queue instead of a provider at its limit. The role now stays idle with its queued messages kept — one `run_failed` item (or the provider-switch notice) makes the failure visible once — until its provider switch, its next message, or the limit's reset. Agent sessions keep their automatic retry as before.
