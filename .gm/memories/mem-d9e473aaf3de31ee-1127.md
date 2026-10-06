---
key: mem-d9e473aaf3de31ee-1127
ns: default
created: 1791256427155
updated: 1791256427155
---

A before/after terrain raycast comparison is only meaningful when the resident field set is pinned, and the harness must enforce it rather than assume it: settle until the snapped corner set is stable (1.5 s) and the streamer reports not busy, scale the ray length from the resident sample range (originY = max + 50, length = range + 120) or low ground reads as a miss, classify a point by the CORNERS covering it rather than by bodyId (bodyId always changes across a resculpt, so bodyId classification marks every point changed), and pin the terrain/physics tree hash before and after. Without the settle, a rebuild or retire is in flight when the grid is taken and misses appear to track machine load: 19968 misses after forced churn in drift-churn.mjs, where 12800 points changed hit bodyId and the max difference where the hit body changed was 16.933 mm while points with the same hit body were 0. That residency mechanism is separate from sample content and is not fixed by snapping samples; a point whose covering corner changed, or whose field was retired and not yet replaced, is a residency event, not a height defect.
