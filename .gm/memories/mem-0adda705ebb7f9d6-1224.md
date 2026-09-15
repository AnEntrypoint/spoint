---
key: mem-0adda705ebb7f9d6-1224
ns: default
created: 1789457419159
updated: 1789457419159
---

## Resolved mutable: decide-adversarial-snapshot-validation-gap

Fixed in src/client/PredictionEngine.js: added isFiniteVec/isValidPlayerSnapshot module-level helpers; onServerSnapshot now returns early if snapshot.players is not an array, and skips (continue) any serverPlayer entry that fails shape/finiteness validation, before ever calling _copyState into lastServerState -- closing the single upstream point all three findings flowed through. Re-witnessed live (exec_js dispatch exec_js-fade-sil-1-17456-1789457392310-481) against the exact reviewer-reported reproductions: undefinedPlayers/noPlayersField/playersIsString all 'ok' (no throw), missingVelocity 'ok' with lastServerStateUntouchedByMalformed=true, shortPositionArray 'ok' with lastServerStateUntouchedByShortPos=true and localStateStillFinite=true (confirms the resimulate()-bypasses-applyCorrection's-guard path is closed at the source, not patched downstream), validSnapshotStillApplies=true (no false-positive rejection of well-formed data). Regression-checked the wedge-gate mechanism from f2d4d01e still functions identically after this change (wedgedAfterSnapshot1=true, xMovedWhileWedged=false, wedgedAfterSnapshot2=false, xMovedAfterUnwedge=true).
