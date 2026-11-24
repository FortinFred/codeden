---
section: fixed
---

- **Copilot sessions no longer ask to read CodeDen's own attachments, and "Allow for session" sticks in read-only sessions.** A session's screenshots and pasted files live in its own artifacts folder, which CodeDen hands to the agent; reading one showed an approval card even though CodeDen supplied it. That folder now counts as trusted for reading (writes there still ask). In read-only sessions (the orchestrator and PMs), answering **Allow for session** to a Copilot path prompt now means the same path does not ask again for the rest of the session; a different path still asks, and policy denials still win.
