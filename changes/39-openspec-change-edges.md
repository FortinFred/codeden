---
section: fixed
---

- **OpenSpec changes at the edges of a filesystem.** A change titled after a Windows device name (`CON`, `NUL`, `COM1`…) now creates and reads normally instead of failing; a change folder whose only leftover is a half-written `proposal.md` from an interrupted write can be created again under the same title instead of answering `openspec_change_exists` forever; and a factory check skips a `proposal.md` over 1 MB rather than loading it every 30 seconds.
