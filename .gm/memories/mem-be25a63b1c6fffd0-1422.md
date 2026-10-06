---
key: mem-be25a63b1c6fffd0-1422
ns: default
created: 1791275811514
updated: 1791275811514
---

A harness that captures {expected, got} and returns it without comparing the two has verified nothing: it prints a pass-shaped row whether the guard fired or not, and exits 0 either way. scripts/cluster-world-harness.mjs did exactly this for all four resolveClusterConfig refusals (cluster-link-below-relevance-ring, cluster-link-below-weapon-range, cluster-radius-exceeds-walkable-chart, cluster-worlds-exceed-wasm-heap-budget) and for its disabled-flag check -- every one was a returned object, never an assertion. The proof a guard fired is INJECTION: break the expectation and confirm the run fails. Adding a fifth expected refusal that cannot fire made the harness exit 3 naming 'got no throw at all'; the unmodified harness exits 0 with fired:true on all four. The second, subtler half: a guard can be correct and still stop being exercised. The hosting scenario hardcoded 5 extra clusters, which reached the cap when CLUSTER_HEAP_WORLD_CEILING was 5 but not after it was raised to 8 -- so the capacity refusal silently retired itself and the run kept reporting refusalIsNamed:false with no failure. Any count a test uses to provoke a limit must be derived from the limit (extraCount = maxWorlds - alreadyHosted + 1), never hardcoded. Generalize: whenever a ceiling, budget or cap is raised, check whether some test's hardcoded quantity was tuned to the OLD value, or the test becomes a no-op that still prints rows.
