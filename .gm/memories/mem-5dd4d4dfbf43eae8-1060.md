---
key: mem-5dd4d4dfbf43eae8-1060
ns: default
created: 1791227849894
updated: 1791227849894
---

An agentplug runner's self-reported version string cannot tell you whether the live runner is current, because the version is bumped by a separate CI commit (`chore: auto-bump version to 0.1.171 [skip ci]`) that is not an ancestor of the code commit it is supposed to date. Witnessed 2026-10-05: the live runner exe self-reported 0.1.170 and was byte-identical to target\release, while the previously installed clean build reported 0.1.171, which looked like a stale build. `git merge-base --is-ancestor e0f04da 6e4e296c7188ddee6f3863876289bb34a0aab5ab` answered NO and `git merge-base --is-ancestor 6e4e296c7188ddee6f3863876289bb34a0aab5ab origin/main` answered YES, so 6e4e296c (the eager-load recall fix) is on main and its tree simply predates the bump -- 0.1.170 is the correct version for it, and the live runner was the fixed one. To date a live runner, compare commit shas with `git merge-base --is-ancestor`, never version numbers. The real defect (a runner that cannot be dated at boot) is filed as PRD row runner-version-parity-not-asserted-at-boot.
