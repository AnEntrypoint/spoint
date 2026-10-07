---
key: mem-bae668ac54d8e4ae-934
ns: default
created: 1791398374789
updated: 1791398374789
---

spoint veg LOD witness trap: a brute-force oracle for WebGPULodInstancer must replicate two updateLOD rules or it reports tier mismatches that are not real. (1) updateLOD only refreshes lodEye once the camera has moved LOD_REEVAL_MOVE_SQ (0.5 m) since the last refresh, so distances come from a LAGGED eye while frustum planes are refreshed every call; the oracle has to track its own lagged eye with the same 0.25 threshold. (2) addInstances and removeInstances set lodStale = true, so an oracle fed by a stream that adds every frame must also mark its reference stale on every add, or the instancer refreshes each frame while the oracle lags. Cost of getting this wrong: 33 and 2937 phantom mismatches on dense2k/real90 that vanished once both rules were mirrored. Also: reading a lagged eye stored as an array with e.x/e.y/e.z yields undefined, NaN distances, and tier 0 for every instance -- the same class of silent wrong answer.
