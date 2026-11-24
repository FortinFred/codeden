---
section: security
---

- **A symlinked change folder no longer writes outside the project.** When `openspec/changes/<slug>` is a symbolic link, New change refuses it with `openspec_change_root_unsafe` and touches nothing there, as it already did for a symlinked `openspec` or `openspec/changes`; a real leftover folder is still reused.
