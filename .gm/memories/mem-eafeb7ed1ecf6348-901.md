---
key: mem-eafeb7ed1ecf6348-901
ns: default
created: 1789456813444
updated: 1789456813444
---

## Resolved mutable: res-sweep-predictionengine-crucible

exec_js live run against 4 degenerate cases: (1) onServerSnapshot({players:[]}) -> no throw. (2) snapshot with velocity=[NaN,Infinity,-Infinity] -> horizontallyWedged correctly computed false (NaN comparisons are always false, so the wedge condition fails open rather than getting stuck true), predict() does not throw on the NaN-poisoned state. (3) a subsequent normal snapshot fully recovers lastServerState to all-finite values -- no permanent NaN taint. (4) resimulate() with zero buffered inputHistory entries does not throw (loop body simply never executes). Fail-safe direction confirmed: corrupted/degenerate server data never traps the client in a stuck wedged=true state, it only ever fails toward normal (ungated) prediction, the same behavior as before this session's fix -- no new crash surface, no new silent-corruption surface.
