---
section: fixed
---

- **Factory issue intake no longer wakes the PM.** In a software or dark factory project, an issue that the factory loop takes on is still recorded as a skipped automation run in the Runs tab, but its routine `factory_intake` skip no longer sends an `automation.skipped` notice, so filing an issue does not wake (or start) a PM just to read the skip. Every other skip reason still notifies the PM as before.
