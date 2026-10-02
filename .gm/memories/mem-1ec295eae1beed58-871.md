---
key: mem-1ec295eae1beed58-871
ns: default
created: 1790957073321
updated: 1790957073321
---

project/spawn-pose-moved-forward-motion-assertions-2026-10-02: the tps-game spawn pose changed, so any forward-motion assertion written against the old origin is measuring the old bug, not the engine. Expect roughly 2.36 m of travel before the wall from (-15, 3.64, -12.5) -- NOT the old (-15, 3.64, -10.14) origin. The move came from e8d2355b, where a player authored 0.16 m from a wall face could not walk at all because spawn placement only probed vertical ground and headroom. Live witness values seen after the change: position (-15, 3.6, -12.5), hashVersion 2, vegetation 3143 / impostors 3022 / grass 7964 / rocks 114 at spawn, and 12.25-12.69 m of travel when holding W for 1.8 s in arena-combat (a different world, no terrain). If a walking/forward-motion check reports near-zero travel, check which pose it asserts before concluding the movement code regressed.
