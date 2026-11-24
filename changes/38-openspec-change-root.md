---
section: security
---

- **OpenSpec changes stay inside the project.** A repository with a symlinked `openspec` or `openspec/changes` folder is refused when you create a change (`openspec_change_root_unsafe`), and its proposals are no longer read by the factory, so no change folder or proposal text comes from outside the project.
