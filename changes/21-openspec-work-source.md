---
section: added
---

- **OpenSpec as a factory work source.** A project's software or dark factory can find its work in OpenSpec change folders instead of GitHub issues (**Work source** in the factory settings). Each folder under `openspec/changes/` with a `proposal.md` becomes a feature item, already trusted and classified: the proposal's first heading is the title, and the builder keeps `design.md`, the spec delta under `specs/` and a `tasks.md` checklist in that folder, so the plan travels in the pull request. Nothing is created or commented on GitHub; the item page shows the change and its path. Pull requests, CI, review, the merge queue, reverts and evidence stay on GitHub, so this needs a GitHub project, and a central OpenSpec store (a store in its own repository) is not covered yet.
