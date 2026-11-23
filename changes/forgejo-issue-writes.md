---
section: added
---

- **The PM can triage a Forgejo project's issues.** On a forge project, the PM and agents can create an issue, comment on one, add or remove labels and close it, so the issue triage automation works there as it does on GitHub: classify the issue, apply the policy's labels, leave a comment, and close duplicates or out-of-scope reports. Labels resolve from their names; one that does not exist in the repository is dropped and logged rather than guessed, and every write reads the issue back so CodeDen shows what actually applied. Forgejo cannot record why an issue was closed, so CodeDen leaves the reason empty and never reports a closed forge issue as completed. Pull requests, evidence and vision stay read-only on a forge project until a later phase.
