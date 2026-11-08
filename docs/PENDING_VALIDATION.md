# Pending validation

Phase A changes are code, docs and tests written without running anything. Phase B runs each witness below, then the gate. Nothing here has been pushed unless the commit column says so.

## Coded in Phase A

| Row | Change | Commit | Files | Witness to run in Phase B |
|---|---|---|---|---|
| 2 | The ack rebase replays each history entry with its own ground normal (`e.normal`), not the ack's. `slopeRise` only moves the floor when the sampler returns no finite height. | 3c7efbd (pushed before Phase A) | `src/client/PredictionEngine.js` (`_rebaseAndReplay`), `scripts/prediction-reconcile-witness.mjs`, `AGENTS.md`, `docs/index.html` | `node scripts/prediction-reconcile-witness.mjs`, expect `RESULT: PASS` with 21 checks. Red before the fix was 20/21 (corrected ack on a changing normal: 35.004 m off the reference). |
| 2 | `ReconciliationEngine.decay` keeps its clock at `null` until the first call, so a clock reading of 0 counts as a real timestamp. | a9a43da | `src/client/ReconciliationEngine.js`, `scripts/prediction-reconcile-witness.mjs`, `AGENTS.md`, `docs/index.html` | `node scripts/prediction-reconcile-witness.mjs`, expect `RESULT: PASS` with 22 checks. Red before the fix was 21/22 (decay from t=0 left the offset at 1.0, not e^-1). |
| 16, 17 | Spoint's snapshot tiers and unmanaged delivery written down from the code. Jayzee's row 16 wording ("5 Hz beyond 120 m") does not match spoint and needs its owner to correct it. | 2904231 | `docs/netcode.md` ("Snapshot detail and delivery"), `docs/index.html` | None yet. Claims come from `classifyPlayerTiers` and `filterEncodedPlayersTiered` (`src/netcode/SnapshotEncoder.js`), `reducedTickMod` (`src/sdk/TickHandler.js`) and `resolveDeliveredIds` (`src/sdk/TickHandlerAOI.js`). A witness needs 31+ players at mixed distances and an unmanaged id inside and outside the gate points. |
| 21 | The session TTL: default 30 s, servers pass 60 s, strict expiry past the TTL, timer re-armed on each touch. | 2904231 (doc), d8fe023 (witness) | `docs/netcode.md` ("Session TTL"), `scripts/session-store-ttl-witness.mjs` | `node scripts/session-store-ttl-witness.mjs`, expect `RESULT: PASS` with 7 checks. |
| 26 | `findCostCorridor` budget: defaults to `Infinity`, exhausted budget returns `{ ok: false, reasonCode: 'budget-exhausted', points: [], truncated: true }`. | 2904231 | `docs/navmesh-pathfinding.md` ("Corridor search budget"), `docs/index.html` | None yet. A witness would call `findCostCorridor` with a small finite budget on a known grid and check the refusal shape. The 20000 figure from jayzee's row 26 has no constant in spoint's pathfinding sources or docs. |

## Decisions and open items, no code change

- Row 2, `resimulate()` (`src/client/PredictionEngine.js`): no callers in `src`, `client`, `scripts`, `apps` or `bin`. It still replays with a null predicted entry and the current move state, the same stale-state class that was fixed for acks. It is dead, so it is left as is. If it is ever wired in, it needs a witness that compares it with a fresh replay.
- Row 2, `applyChartTransfer` (`src/client/PredictionEngine.js`): reviewed, no change. It re-expresses each entry's normal and the last server normal, and `_replayInputsAfterChartSwitch` replays with the stored normals, so it agrees with the fix above. Witness to run in Phase B: `node scripts/chart-reanchor-wire-harness.mjs` with its existing `--keepSurface` and `--serverTrace` options.
- Row 2, the 50/10/2% conditioner row: `scripts/netcode-conditioner-harness.mjs` showed 24 local pops/min and a 27.4 cm max pop on the `on` arm in 4 of 6 runs on the tree with the normal fix, and 0 in the other 2. Reverting the decay change alone (`git diff a9a43da~1 a9a43da -- src/client/ReconciliationEngine.js`) left the outlier in one of two runs. The engine-only A/B against HEAD was interrupted before it produced results. Phase B: run the harness three times on the current HEAD and three times with `src/client/PredictionEngine.js` and `src/client/ReconciliationEngine.js` from a15d570, and compare the 50/10/2% `on` row. The normal fix only moves a replay when the ground sampler returns no finite height, so the harness is not expected to change; this run is to confirm that.
- Open, owner decision: the conditioner outlier and the replay base `groundY`. Four instrumented runs of the 50/10/2% `on` arm logged 0 pops, and 11 runs in total since the outlier was first seen have not reproduced the 24 pops/min. In those runs, 55 corrections had a rebase jump above 2 cm. Of the 20 non-first-contact corrections with a jump above 0.2 m, all had ack errors of 0.03 to 0.23 m, a grounded flat walk, `verticallyBlocked` false and `stalled` 0, and the per-step replay offsets grew from 0.03 m to 1.02 m over nine inputs. Stale acks were ruled out as the cause: all 2,095 stale acks had `wedged` false and `stalled` 0. The unverified candidate is `_rebaseAndReplay` setting the replay base `ls.groundY` from the server position (`src/client/PredictionEngine.js`, the `ls.groundY = server.onGround || this.verticallyBlocked ? sp[1] : NaN` line), where the live path carries its own stepped `groundY`. The replay base is not changed. A change needs a witness that puts a grounded ack 3 to 30 cm off the predicted path on flat ground and checks that the replay matches the live path step by step.
- Row 21, `probeSpawnGroundY` (`src/sdk/Relocation.js`): drops the reason and returns only `y`. Its four callers (lines 101, 114, 120, 221) treat `null` as groundless and do not need the reason, so no change. The reason-carrying path is `probeSpawnHoldGround`.
- Row 21, silent default: `SessionStore` uses `options.ttl || 30000` and `server.js` uses `config.sessionTTL || 60000`, so a TTL of 0 (or NaN) becomes the default. Whether 0 is a valid TTL is an owner decision. Not changed.
- Row 11 (rollback loop), row 12 (lockstep), row 18 (server authority per tick), row 34 (tick governor), row 35 (telemetry): the open items named in jayzee's rows are on jayzee's side (ports, a missing tick host, or spawn learnings absent from both repos). No spoint change.
- Row 42 (lag compensation): the open item is that spoint's callers of `applyChartTransfer` are not wired in jayzee. Spoint's `LagCompensator.applyChartTransfer` (`src/netcode/LagCompensator.js`) is unchanged.

## Held, not coded

- Row 7 (character controller): held by the owner.
- Row 33 (world persistence): held by the owner. Spoint's restore compares the world name and never the fingerprint.
- Row 44 (protocol codecs): held by the owner.
- WebGL dot look (`client/core/PlayerLOD.js`, `client/core/PlayerLODTSL.js`): unchanged. Single dot 2.7 m to 1.96 m and largest 24.7 m to 5.9 m wait for the owner's decision.

## Docs index

`docs/index.html` was regenerated with `node scripts/generate-docs-site.js` after the `netcode.md` and `navmesh-pathfinding.md` edits, because the generator reads spoint's `docs/*.md`. It is a generated file, so check it again if either doc changes.
