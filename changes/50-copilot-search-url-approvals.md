---
section: fixed
---

- **Copilot's prompts for searches outside the project and for URLs now show in CodeDen.** A Copilot CLI search that reaches outside the folders it trusts used to be approved quietly, like its reads, so a session could search past what Copilot itself allows without ever asking; it now arrives as an approval card naming the path, at every level. Its URL asks now arrive the same way as a network card naming the URL, instead of being granted by the permission level. **Allow for session** stops that path, or any URL on that host, asking again for the rest of the session, and **Deny** refuses the call. Commands and edits are still judged as what they are.
