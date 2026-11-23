---
section: added
---

- **Connect a self-hosted Forgejo instance.** Settings → Forges → Forgejo takes the instance's web URL, an optional SSH host, an explicit plain-HTTP opt-in with a warning that the token then travels unencrypted, and an access token stored only in the OS keychain. **Test connection** reports whether Forgejo is configured, whether a token is stored, and whether the instance answered, naming the token's login and Forgejo version when it can, or saying that the token cannot read its account (a repository-only token). A folder whose `origin` matches the connection is added as a forge project and shown as a **Forgejo repository** with its host, owner and repository. Issues, pull requests and the factory stay off for forge projects in this release; when the folder loses its matching remote, the project page warns and **Disconnect forge** makes it local-only. Nothing is written to Forgejo yet.
