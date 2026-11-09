# Pending validation

Phase A changes are code, docs and tests written without running anything. Phase B runs each witness below, then the gate. Nothing here has been pushed unless the commit column says so.


Commit hashes in this file were rewritten to the current `origin/main` history (owner-approved rewrite that removed the old author email). Old hashes are replaced by the new commit with the same subject: 0197ebf to 7bb9e43, 096e298 to bae3c98, 54229e9 to a540e75, 8e44515 to 8a201ff, b66a1b5 to fa478a3, fa25370 to 715ab77.
## Coded in Phase A

| Row | Change | Commit | Files | Witness to run in Phase B |
|---|---|---|---|---|
| 2 | The ack rebase replays each history entry with its own ground normal (`e.normal`), not the ack's. `slopeRise` only moves the floor when the sampler returns no finite height. | 3c7efbd (pushed before Phase A) | `src/client/PredictionEngine.js` (`_rebaseAndReplay`), `scripts/prediction-reconcile-witness.mjs`, `AGENTS.md`, `docs/index.html` | `node scripts/prediction-reconcile-witness.mjs`, expect `RESULT: PASS` with 21 checks. Red before the fix was 20/21 (corrected ack on a changing normal: 35.004 m off the reference). |
| 3 | Player collision impulse moves to the next tick, on both sides. Server: `applyPlayerCollisions` applies the push planned at the previous tick after movement, then `planPlayerCollisions` plans the next push from the state the snapshot publishes (after the applied push), over frozen positions, so the published state at a tick never carries a push planned from that same tick. Client: `_planPeerPush` plans the push from an acked state and its snapshot peers at lead 0; `_step` applies the planned push after movement; the first input replayed after an ack uses the push planned from that ack (`_rebaseAndReplay`); later replayed inputs keep their stored push. `_planPeerPush` replaces `_separateFromPeers` and plans from the frozen state, matching the server. Resim snapshots (`PlayerManager.snapshotState`/`restoreState`) carry the planned push. Teleports clear it on both sides. Known gap, not witnessed: a chart reanchor between a plan and its application. The server applies a push planned before the reanchor in the new basis; the client re-plans from the re-expressed base. | Phase A, this commit | `src/netcode/CollisionSystem.js`, `src/sdk/TickHandler.js` (`simulateTick`), `src/client/PredictionEngine.js` (`_step`, `_planPeerPush`, `_rebaseAndReplay`, chart replay), `src/sdk/Relocation.js`, `src/netcode/PlayerManager.js` | `node scripts/groundy-replay-witness.mjs` (RESULT: PASS, under 1 cm in every run), `node scripts/peer-replay-witness.mjs`, `node scripts/prediction-reconcile-witness.mjs`, `npm run check` |
| 2 | `ReconciliationEngine.decay` keeps its clock at `null` until the first call, so a clock reading of 0 counts as a real timestamp. | a9a43da | `src/client/ReconciliationEngine.js`, `scripts/prediction-reconcile-witness.mjs`, `AGENTS.md`, `docs/index.html` | `node scripts/prediction-reconcile-witness.mjs`, expect `RESULT: PASS` with 22 checks. Red before the fix was 21/22 (decay from t=0 left the offset at 1.0, not e^-1). |
| 16, 17 | Spoint's snapshot tiers and unmanaged delivery written down from the code. Jayzee's row 16 wording ("5 Hz beyond 120 m") does not match spoint and needs its owner to correct it. | 2904231 | `docs/netcode.md` ("Snapshot detail and delivery"), `docs/index.html` | None yet. Claims come from `classifyPlayerTiers` and `filterEncodedPlayersTiered` (`src/netcode/SnapshotEncoder.js`), `reducedTickMod` (`src/sdk/TickHandler.js`) and `resolveDeliveredIds` (`src/sdk/TickHandlerAOI.js`). A witness needs 31+ players at mixed distances and an unmanaged id inside and outside the gate points. |
| 21 | The session TTL: default 30 s, servers pass 60 s, strict expiry past the TTL, timer re-armed on each touch. | 2904231 (doc), d8fe023 (witness) | `docs/netcode.md` ("Session TTL"), `scripts/session-store-ttl-witness.mjs` | `node scripts/session-store-ttl-witness.mjs`, expect `RESULT: PASS` with 7 checks. |
| 26 | `findCostCorridor` budget: defaults to `Infinity`, exhausted budget returns `{ ok: false, reasonCode: 'budget-exhausted', points: [], truncated: true }`. | 2904231 | `docs/navmesh-pathfinding.md` ("Corridor search budget"), `docs/index.html` | None yet. A witness would call `findCostCorridor` with a small finite budget on a known grid and check the refusal shape. The 20000 figure from jayzee's row 26 has no constant in spoint's pathfinding sources or docs. |
| groundY owner item (24 pops/min outlier, `_rebaseAndReplay` replay base) | Decides the `groundY` hypothesis from evidence, without changing the replay base. A replay's growth is its last-entry offset minus the acknowledged error (`growthM`). Each replay also records the server `groundY` (server y when grounded or vertically blocked), the predicted `groundY` at the ack, and both gap. Verdict: PASS only if no replay grows more than 1 cm (the documented pop threshold, `detectPops` default) across at least 15 runs of the 50/10/2 `on` arm. The control injects a 0.03 m y error on every ack on the flat arena and must show growth over 1 cm; by code reading this may fail, since the finite sampler absorbs the error. | Phase A, this commit | `scripts/groundy-replay-witness.mjs` (driver), `scripts/lib/groundy-replay-hook.mjs` (preloaded with `node --import`, wraps `onServerSnapshot` and `_rebaseAndReplay` without editing the engine) | Phase B run, final code (`node scripts/groundy-replay-witness.mjs`, 15 runs of 50/10/2 `on`): `RESULT: FAIL` (exit 1). 68 of 98 mover replays grew over 1 cm, in 15 of 15 runs, max growth 2.5917 m. None of those 68 had a `groundY` gap (`serverGroundY` equal to `predictedGroundY`), so the base mismatch is not what produced these replays. Local pops appeared in 8 of 15 runs, three of them at 23.99 pops/min, so the outlier reproduced in this harness. Control (`node scripts/groundy-replay-witness.mjs --control`): `RESULT: PASS` (exit 0). 66 mover replays carried the injected 0.03 m `groundY` gap and 42 of them grew over 1 cm, so the mechanism does produce growth when the base is mismatched. Those 66 are every replay that still carries the gap, not only the injected acks. Corrections to the Phase A note: the harness installs no ground provider (`predictionGroundSurface` is never set), so `characterStep` takes its floor from `state.groundY` on every step, and the flat-ground absorption argument did not hold. No documented replay-offset threshold exists; 1 cm is taken from the pop definition. Phase B fixes were to the witness only: the hook keyed engines wrongly (`WeakMap` has no size), so the pooled shooter and bots were counted and the mover was not isolated; the mover is now matched to the harness's own correction count and jump statistics; the injection was applied on every ack, which the base absorbs, so it is now every 25th local ack; and the output now counts over-limit replays that carry a `groundY` gap. Open, owner decision: what causes the natural replay growth if not the `groundY` base, and whether the sampler-edge world is still needed to test the base. The replay base is unchanged. |

## Decisions and open items, no code change

- Row 2, `resimulate()` (`src/client/PredictionEngine.js`): no callers in `src`, `client`, `scripts`, `apps` or `bin`. It still replays with a null predicted entry and the current move state, the same stale-state class that was fixed for acks. It is dead, so it is left as is. If it is ever wired in, it needs a witness that compares it with a fresh replay.
- Row 2, `applyChartTransfer` (`src/client/PredictionEngine.js`): reviewed, no change. It re-expresses each entry's normal and the last server normal, and `_replayInputsAfterChartSwitch` replays with the stored normals, so it agrees with the fix above. Witness to run in Phase B: `node scripts/chart-reanchor-wire-harness.mjs` with its existing `--keepSurface` and `--serverTrace` options.
- Row 2, the 50/10/2% conditioner row: `scripts/netcode-conditioner-harness.mjs` showed 24 local pops/min and a 27.4 cm max pop on the `on` arm in 4 of 6 runs on the tree with the normal fix, and 0 in the other 2. Reverting the decay change alone (`git diff a9a43da~1 a9a43da -- src/client/ReconciliationEngine.js`) left the outlier in one of two runs. The engine-only A/B against HEAD was interrupted before it produced results. Phase B: run the harness three times on the current HEAD and three times with `src/client/PredictionEngine.js` and `src/client/ReconciliationEngine.js` from a15d570, and compare the 50/10/2% `on` row. The normal fix only moves a replay when the ground sampler returns no finite height, so the harness is not expected to change; this run is to confirm that.
- Open, owner decision: the conditioner outlier and the replay base `groundY`. Four instrumented runs of the 50/10/2% `on` arm logged 0 pops, and 11 runs in total since the outlier was first seen have not reproduced the 24 pops/min. In those runs, 55 corrections had a rebase jump above 2 cm. Of the 20 non-first-contact corrections with a jump above 0.2 m, all had ack errors of 0.03 to 0.23 m, a grounded flat walk, `verticallyBlocked` false and `stalled` 0, and the per-step replay offsets grew from 0.03 m to 1.02 m over nine inputs. Stale acks were ruled out as the cause: all 2,095 stale acks had `wedged` false and `stalled` 0. The unverified candidate is `_rebaseAndReplay` setting the replay base `ls.groundY` from the server position (`src/client/PredictionEngine.js`, the `ls.groundY = server.onGround || this.verticallyBlocked ? sp[1] : NaN` line), where the live path carries its own stepped `groundY`. The replay base is not changed. A change needs a witness that puts a grounded ack 3 to 30 cm off the predicted path on flat ground and checks that the replay matches the live path step by step.
- Row 21, `probeSpawnGroundY` (`src/sdk/Relocation.js`): drops the reason and returns only `y`. Its four callers (lines 101, 114, 120, 221) treat `null` as groundless and do not need the reason, so no change. The reason-carrying path is `probeSpawnHoldGround`.
- Row 21, silent default: `SessionStore` uses `options.ttl || 30000` and `server.js` uses `config.sessionTTL || 60000`, so a TTL of 0 (or NaN) becomes the default. Whether 0 is a valid TTL is an owner decision. Not changed.
- Row 11 (rollback loop), row 12 (lockstep), row 18 (server authority per tick), row 34 (tick governor), row 35 (telemetry): the open items named in jayzee's rows are on jayzee's side (ports, a missing tick host, or spawn learnings absent from both repos). No spoint change.
- Row 42 (lag compensation): the open item is that spoint's callers of `applyChartTransfer` are not wired in jayzee. Spoint's `LagCompensator.applyChartTransfer` (`src/netcode/LagCompensator.js`) is unchanged.

## Decisions pass: released holds and owner decisions

Each change below is listed with its file, its row or phase, and the witness that checks it. Phase B runs the witnesses and the gate, then pushes.

| Item | Decision | Files | Witness |
|---|---|---|---|
| groundY replay base (owner item) | Kept as is. The base is not changed: the 15-run witness (`scripts/groundy-replay-witness.mjs`, final code) gave `RESULT: FAIL`, 68 of 98 mover replays over 1 cm, and none of the 68 had a `groundY` gap. The control gave `RESULT: PASS`, so the mechanism does produce growth when the base is mismatched, but that mismatch is not what produced the natural replays. Open: what causes the natural growth. | none | `node scripts/groundy-replay-witness.mjs` (FAIL recorded), `node scripts/groundy-replay-witness.mjs --control` (PASS recorded) |
| Session TTL 0 (owner item) | Rejected at config time. `resolveSessionTtl` accepts an absent ttl (30 s default) or a positive finite number, and throws a `RangeError` for zero, negative, non-finite or non-number values. `server.js` passes `config.sessionTTL` through with no `||` fallback. | `src/connection/SessionStore.js` (`resolveSessionTtl`), `src/sdk/server.js`, `docs/netcode.md` ("Session TTL") | `node scripts/session-ttl-config-witness.mjs`, and the existing `node scripts/session-store-ttl-witness.mjs` (7 checks) |
| Row 33, world persistence (released; a defect) | Restore compares the definition fingerprint as well as the name. The snapshot stores `definition` (`worldDefFingerprint` of the current definition) at save. Restore refuses an edited definition under the same name (`definition-mismatch`), refuses a snapshot without a fingerprint, and refuses when no current definition exists (`no-world-definition`). The name check stays. | `src/sdk/WorldPersistence.js` (`definitionFingerprintOf`, `buildWorldSnapshot`, `restoreWorldSnapshot`), `AGENTS.md` (world restore caveat) | `node scripts/world-persistence-fingerprint-witness.mjs` |
| WebGL dot look (owner decision) | No constant changed. Reading `client/core/PlayerLOD.js`, the single dot's geometry is `dotSize` (1.4) and its instance scale is `dotSize`, applied once, which gives 1.96 m. The largest bucket is `dotSize` times its scale of `dotSize` times 3, which gives 5.88 m, about 5.9 m. So the requested values are what the current source already draws. The 2.7 m and 24.7 m figures are not produced by the current source, and the 24.7 m largest dot is the one the owner called an overdraw. Closed in the section "Replay growth, pops and the dot look (this pass)" below: the witness now expects 1.96 m single and 5.9 m largest, and the playwriter browser run passes. | none (`client/core/PlayerLOD.js`, `client/core/PlayerLODTSL.js` unchanged) | `node scripts/crowd-dot-render-witness.mjs --check=<result.json>` (browser run via playwriter: PASS) |
| Row 7, character controller (released; not implementable here) | Not changed in spoint. The row says porting `CharacterManager` (a Jolt wrapper) is an owner decision and jayzee has no Jolt backend. Releasing the hold does not make that decision. | none | none (jayzee-side) |
| Row 44, protocol codecs (released; jayzee-side) | Not changed in spoint. The row's open items are jayzee's msgpackr-backed wire and byte compatibility, not a spoint defect. | none | none (jayzee-side) |

## Phase B results for the decisions pass

Run on commit `02dab97` (the decisions pass) with the final code. Exit codes are the process exit codes; the RESULT lines are the witnesses' own.

- `node scripts/session-ttl-config-witness.mjs`: `12/12 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/session-store-ttl-witness.mjs`: `7/7 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/world-persistence-fingerprint-witness.mjs`: `10/10 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/prediction-reconcile-witness.mjs`: `22/22 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/snapshot-lod-tiers-witness.mjs`: `9/9 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/resolve-delivered-ids-witness.mjs`: `10/10 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/corridor-budget-witness.mjs`: `8/8 checks passed`, `RESULT: PASS`, exit 0.
- `node scripts/chart-reanchor-wire-harness.mjs`: exit 0, prints its `RESULT_JSON` block (no `RESULT:` line of its own).
- `node scripts/groundy-replay-witness.mjs` (15 runs, final code, run before this pass): `RESULT: FAIL`, exit 1, 68 of 98 mover replays over 1 cm in 15 of 15 runs, none with a `groundY` gap. Its control `--control`: `RESULT: PASS`, exit 0, 42 of 66 replays carrying the injected gap over 1 cm.
- `node scripts/crowd-dot-render-witness.mjs`: not run. It needs a headful browser, and it is the witness the dot-look open item depends on.
- `npm run check`: exit 0, 135 `RESULT: PASS`, 0 `RESULT: FAIL`.

## Replay growth, pops and the dot look (this pass)

Commits on `main` after `a033468`, none pushed: `b4941c5` (peer replay witness), `796c147` (peer push replay fix), `78c1fa4` (harness forwards the stored push, reports pop times and skipped input gaps), `dcf55c8` (groundY driver correlates pops with corrections and peer contact), `fb91a09` and `312798c` (dot witness).

Monitor logs, read back from `/tmp/popdiag/`:

- Pre-fix baseline (`b4941c5` engine, 15 runs, clean rerun): `RESULT: FAIL`, exit 1. Totals: 85 replays, 56 over 1 cm (max growth 2.7370 m), 5 runs with pops, max 17.99 pops/min, 10 pops, 9 matched within 100 ms of a correction, 6 of them in peer contact. An earlier baseline attempt overlapped a second driver writing the same log, so its numbers (125 replays, 89 over) were discarded.
- Fixed engine (`796c147`, 15 runs): `RESULT: FAIL`, exit 1. Totals: 79 replays, 50 over 1 cm (max 2.6405 m), 7 runs with pops, max 29.98 pops/min, 25 pops, 24 matched within 100 ms of a correction, 3 of them in peer contact.

Row: replay natural growth. Witness PASS after Phase B (15 of 15 runs under 1 cm, see "Replay growth: Phase B" below), with a sample caveat: the witness records one mover replay per run. The earlier 6 of 23 and 52 of 77 counts came from the all-replay probe and the pre-Phase-B builds, so the all-replay count for this build is not measured. Option 1 (row 3 under "Coded in Phase A", commit a540e75) is in. Cause found earlier: a server peer-collision impulse that the client does not predict in time; the next-tick rule does not remove the growth it produces.

Cause, measured this pass (instrumented server tick log, client replay probe, same process, three harness runs at `--cond=50/10/2`):
- Server tick 345 (ack 311) for pid 2, t 5612 ms: pid 2 was idle at (0, 1.2, 10) with velocity 0 at tick 344. Pid 1 was running at about -9.8, 0, +10.0 m/s and was 0.71 m away at that tick (`CollisionSystem.js applyPlayerCollisions`, minimum 2 x capsuleRadius = 0.8 m). Pid 2's velocity became (1.005, 0, 1.695) and it moved onto a 0.2 m higher ground patch with no input, which is the push. `simulateTick` runs `applyPlayerCollisions` after `processPlayerMovement`, so the impulse is in the tick's state under that tick's ack.
- Contact against replay drift, 48 replays across runs 6 to 8: 39 of 39 over-limit replays had a server contact (player pair under 0.8 m) in the 350 ms before the replay. 0 of 39 over-limit replays had no contact. Of the 9 clean replays, 3 had contact and 6 did not.
- The replay math is deterministic: clean replays with no contact show max deviation 0 to 0.001 mm per step against the original prediction.
- Forward path matches the server: engine 1 against pid 2 gave 1202 steps with zero steps over 1 mm displacement mismatch, and velocity at each ack matched the client's original to 0.003 m/s (run 2). The inputs the server applied matched the client's inputs field by field, sprint included, so input encoding is not the cause.
- Lost inputs are ruled out (`gapsSkipped` 0 in every combined-condition run).

Refuted in this pass:
- Stored peer push as the cause (the replay reuses the push each entry was predicted with, so contact after prediction is ignored). Recomputing separation for every replayed step with current peers (a probe that clears the stored push only during `_rebaseAndReplay`) leaves growth at 13 of 17, 14 of 18 and 13 of 16 replays over 1 cm. The stored push is not the cause.
- The growth metric itself is not a bug in the replay. The witness compares the replayed trajectory with the pre-correction prediction, so an impulse that arrives inside a correction shows up as growth. The replay follows the authoritative velocity, which is the right behaviour, and the measured error is the unpredicted impulse.

Witness re-run this pass (`scripts/groundy-replay-witness.mjs`, 15 runs): `RESULT: FAIL`, exit 1. Totals: 72 replays, 39 over 1 cm in 11 of 15 runs, max growth 2.6405 m, 7 runs with local pops, max 23.99 pops/min, 30 pops, 29 matched to a correction within 100 ms.

The witness's own "in peer contact" count is 3 of 3 contact replays. That undercounts the server contacts (39 of 39 over-limit replays had one in the probe above) because the hook reads the client's peer positions, which are one snapshot old, so it misses most contacts. The witness's contact flag is not a reliable record of the cause and should not be used as one.

Fix options (needs an owner decision, not made in this pass):
1. Make the impulse predictable: the snapshot already carries every player at the same tick. The client would need the same pair geometry as the server at each ack to reproduce `applyPlayerCollisions`. That needs a server change to publish pre-collision positions, or a rule that delays collisions to the next tick.
2. Keep the server authoritative and smooth the visual correction over a short window, so the velocity error is not shown as a pop. This does not change the replay growth, so the witness still fails unless the expectation is restated.
3. Restate the witness expectation: growth is reported separately for corrections with a contact and for corrections without one, and the no-contact case must stay under 1 cm. This is a change of expectation, so it needs the owner to accept it.
Decision (this pass): option 1, the next-tick rule (row 3 under "Coded in Phase A"). Option 2 is not taken, since it smooths the pop and leaves the growth. Option 3 is not taken, since it restates the witness expectation and the witness must not change.
- Fixed in `796c147`: each replayed input now uses the peer push it was predicted with. The peer-replay witness is 2/4 on `b4941c5` and 4/4 on `796c147`. This is a real divergence, but it is not the cause of the growth above (only 3 of 50 over-limit replays were in peer contact).
- Refuted: the groundY base (`serverGroundY` minus `predictedGroundY` is 0 on the fixed run's over-limit replays), and tick dilation (1 on every replay, no `setDilation` call).
- Per-step trace: growth is linear in the number of replayed steps. Over-limit replays have an ack velocity gap (server minus predicted) of 3 to 5.7 m/s, and the per-step horizontal growth is about that gap divided by 60 Hz. Across 45 replays the ack velocity gap quartiles are 0.164, 2.994, 3.103 and 9.679 m/s, with correlation 0.32 against growth. One over-limit replay had a 0.00 m/s gap at speed 14.02 m/s and still grew 2.27 m, so the velocity gap does not explain every case.
- Condition split (single-factor runs have too few replays to decide): jitter 10 ms with loss 2% gave 3 to 4 starved ticks per second and 85 replays, 56 of them growing. No jitter and no loss gave 1 of 10 over 1 cm and 0 starves. Loss only gave 0 of 5 over and 0 skipped gaps. Jitter only gave 0 of 4 over.
- What would settle it: enough single-factor runs for about 50 replays each, and a server-side log of, per snapshot, the state label and the time step each applied input received. `src/sdk/TickHandler.js` keeps `ackSequence` at the last consumed input while starved ticks inside the hold window are not stepped. That path is not confirmed as the mechanism.

Row: pop outlier (24 pops/min). OPEN. The 24 per minute figure is not reproduced in these runs (highest 17.99 before the fix, 29.98 after). The cause as far as measured: pops are corrections that move the rendered body backward, and 9 of 10 baseline pops and 24 of 25 fixed pops fall within 100 ms of a correction. The peer-push fix did not reduce pops, so pops follow the same open growth cause as the row above. This pass confirms it: the corrections that carry a peer-collision impulse are the ones that pop (see the replay growth row for the 39 of 39 contact figure).

Row: WebGL dot look. CLOSED. The witness expects the values the source draws: single dot 1.96 m (geometry 1.4 m times instance scale 1.4, applied once), count-4 bucket 2.55 m, count-9 bucket 3.23 m, largest bucket (count 64, scale 4.2) 5.9 m. The old witness labelled the single dot 1.4 m while its own expectation was 1.96 m, and it never checked the largest dot. Browser check through `gm.playwriter_execute` against the served page (`node scripts/crowd-dot-render-witness.mjs --serve`): single 54 px (expected 53.8), count-4 70 px (69.9), count-9 88 px (88.8), largest 162 px (161.4), DoubleSide control 2916 px. `node scripts/crowd-dot-render-witness.mjs --check=/tmp/popdiag/dot-result.json`: `RESULT: PASS`, exit 0. The captured JSON is outside the repo.

Rows 7 and 44 (jayzee): not changed in spoint. They are recorded against jayzee's own entries in `jayzee/docs/PARITY.md` (row 7, character controller; row 44, protocol codecs), which the owner decides there.

Other witnesses this pass: `scripts/peer-replay-witness.mjs` `RESULT: PASS` 4/4, exit 0; `scripts/prediction-reconcile-witness.mjs` `RESULT: PASS` 22/22, exit 0; `scripts/session-ttl-config-witness.mjs` 12/12; `scripts/session-store-ttl-witness.mjs` 7/7; `scripts/world-persistence-fingerprint-witness.mjs` 10/10, all `RESULT: PASS`, exit 0.

Phase B witnesses run in the foreground for this pass:

- `npm run check`: exit 0. The first run failed on the docs-page freshness witness after the ledger edit; `docs/index.html` was regenerated and the rerun passed, 135 PASS 0 FAIL.
- `scripts/chart-reanchor-wire-harness.mjs`: exit 0, `RESULT: PASS forced scenario: every expectation holds`. The script printed no RESULT line before this pass, so a `RESULT:` line was added (uncommitted until this pass).
- `scripts/snapshot-lod-tiers-witness.mjs`: exit 0, `RESULT: PASS` (9 checks).
- `scripts/resolve-delivered-ids-witness.mjs`: exit 0, `RESULT: PASS` (10 checks).
- `scripts/corridor-budget-witness.mjs`: exit 0, `RESULT: PASS` (8 checks).
- `scripts/crowd-dot-render-witness.mjs --check`: exit 0, `RESULT: PASS`, all six checks ok.
- `scripts/groundy-replay-witness.mjs`: exit 1, `RESULT: FAIL replay growth over 1 cm in 45 of 76 replays across 12 of 15 completed run(s)`. Still open, see the replay growth row.

Combined condition check (jitter 50 ms, jitter 10 ms, loss 2%, 20 s, two runs): run 1 had 73 starves, 0 catch-ups, 0 skipped gaps and 9 of 12 replays over 1 cm; run 2 had 82 starves, 0 catch-ups, 0 skipped gaps and 4 of 6 replays over 1 cm. Skipped gaps are ruled out as the cause: the server consumed every input it received, so the growth comes from the timing of the starved ticks, not from lost inputs.

Not pushed. `origin/main` is `a033468`. The local commits `b4941c5` through `312798c` are held because the replay growth and pop rows are open.

## Replay growth after option 1 (Phase B, this pass)

- Phase A commit: `a540e75` (lanmower, local, no trailers, not pushed). Rule: the separation push is planned from the published state and applied on the next tick. The client plans it from the acked state and its snapshot peers at lead 0, applies it after movement, and uses the planned push for the first input replayed after an ack. Later replayed inputs keep their stored push.
- `npm run check` (after `node scripts/generate-docs-site.js`): exit 0, 135 `RESULT: PASS` lines, no FAIL line.
- `node scripts/groundy-replay-witness.mjs` (15 runs, 50/10/2 `on`): `RESULT: FAIL replay growth over 1 cm in 52 of 77 replays across 15 of 15 completed run(s); 15 requested, 0 failed, 6 run(s) with local pops`, exit 1. Totals: max growth 2.7634 m, 18 pops (max 17.99 pops/min), all 18 matched to a correction within 100 ms. The witness's own contact flag reads 0 of 0 contact replays, which is not a reliable record (its peers are one snapshot old).
- Baseline at 796c147 (15 runs): 50 of 79 replays over 1 cm. After option 1: 52 of 77. The count does not move, so the same-tick push was not the dominant term of the growth in this harness.
- Harness adaptation: `scripts/netcode-conditioner-harness.mjs` wrapped `_separateFromPeers`, which the change renamed to `_planPeerPush`; the harness crashed on its first step. It now wraps `_planPeerPush` and records the planned push magnitude in `sepPushM`. The groundy witness and `scripts/lib/groundy-replay-hook.mjs` are unchanged.
- Why the rule cannot close the row alone: a push planned from an acked state covers the first replayed tick only. Pushes at later ticks depend on peer positions that arrive in later snapshots, after the correction has been replayed, so their velocity error appears as growth. Growth is the replayed last-entry offset minus the ack error, so a velocity error grows linearly with the replayed steps.
- Open, owner decision, not taken in this pass: (a) publish each tick's authoritative push for the local player in the self block (a wire change; the newest ticks still arrive after the replay); (b) make the separation a position-only correction, which removes the velocity term but changes gameplay feel and is not measured here; (c) restate the 1 cm expectation (a witness change). This pass does not smooth the pop and does not change the groundy witness, so the row stays open.
- Not pushed. origin/main is `a033468`, and the Phase B bar (under 1 cm in every run) is not met.

## Option (a): authoritative push in the self block (this pass)

- Wire change, reversible: the self block (`encodeSelfBlock`, `src/netcode/SnapshotEncoder.js`) carries a fifth element, the push planned for the next tick (`collisionPush`, from `NetworkState.setCollisionPush` after `planPlayerCollisions`). The client's `applySelfBlock` reads it, `_reconcile` keeps it on `lastServerState`, and `_rebaseAndReplay` seeds the replay with it (`_seedPendingPush`, zero when the server planned none). `SNAPSHOT_ENTITY_ENC_CODE_VERSION` moved to `32582e7b160e` in `src/shared/cacheCodeVersions.js`.
- Measurement fix: `scripts/lib/groundy-replay-hook.mjs` measured contact against the local position after the replay (a later tick), so it read 0 of 0. It now measures at the ack tick, with the ack position and the ack snapshot's peers. Contact now reads 61 of 62 contact replays in the 15-run witness.
- `npm run check`: exit 0, 135 `RESULT: PASS` lines, no FAIL.
- `node scripts/groundy-replay-witness.mjs` (15 runs, 50/10/2 `on`): `RESULT: FAIL replay growth over 1 cm in 100 of 133 replays across 15 of 15 completed run(s)`, exit 1, max growth 2.7567 m, 0 runs with local pops. The count did not fall, so the self block does not close the row.
- Single 20 s run with the hook's record file (13 replays): 4 of 4 replays with contact at the ack tick are over 1 cm, and 6 of 9 replays without contact are over, up to 2.888 m. So contact at the ack tick is not the whole story.
- Why the count does not fall: the replay already used the exact push for the first tick after an ack (from the snapshot's peers, which are exact), so the self block only removes the quantization of the peer positions (1 cm wire units). The growth is a velocity error from an impulse that the prediction planned from older peer positions. The impulse is learned at the ack that replays it, so it is measured as growth. A position-only correction, or a rule where the impulse is in the ack the prediction already used, would change this; neither is taken here.
- Not pushed. Phase B bar (under 1 cm in every run) not met.

## Replay growth: Phase A changes (local, not pushed)

Each change below is in the working tree and committed locally in Phase A. None is pushed. Every number is a groundy witness run (`scripts/groundy-replay-witness.mjs`, 15 runs, 1 cm bar) unless it says otherwise.

- Tick-to-input mapping defect (cause). The server applied collision pushes per tick, while the client looked them up per input sequence (`seq - pushAckSeq`). A held tick advances the tick but not the sequence, so each push after a hold landed on the wrong input. Fix: the push schedule is a per-player FIFO of 16 entries in `src/netcode/CollisionSystem.js`. Pair pushes accumulate in `pendingPush` between a player's consumed inputs. Each consumed input enqueues `pendingPush` and pops the entry due now, applied after that input's step. The window published with the snapshot is the queue head, so window entry `k` is the push for input `ack + k`, whatever ticks were held.
- Catch-up drain (cause). The first version advanced the queue once per tick, but catch-up consumes extra inputs in some ticks, so the lead of a planned push shrank below the client's prediction horizon. Moving the advance to per consumed input fixed it.
- Idle physics accumulator (cause). `stepPlayerMovement` integrated the time accumulated over idle ticks into the first input after rest. Measured in one tick: ack 198 at velocity 0, then ack 199 at 14 m/s with a 0.4667 m step, twice the 0.2333 m a single input gives, and the client stepped 0.2333 m. Fix: each consumed input steps with its own `dt`, and the accumulator is removed from `src/sdk/TickHandler.js` (`playerAccumDt`, `PHYSICS_MAX_ACCUM_DT`, and the snapshot save/restore fields).
- Client peer separation removed (`PredictionEngine.setPeers`, `_planPeerPush`, `setPlayerRadius`, the `_stepPush` total, and the `playerDefault` import in `MessageHandler.js`). The client no longer predicts pushes from latency-old peer positions. Pushes come only from the window the server publishes.
- `scripts/peer-replay-witness.mjs` is deleted. Its subject, the client's recomputed peer separation, no longer exists, and the witness calls `setPeers`, which is removed. Its earlier PASS in this ledger refers to the removed design.
- Self block field renamed from `collisionPush` to `pushWindow` (`SnapshotEncoder`, `SnapshotProcessor`, `NetworkState`, `PlayerManager`). The snapshot code pin `SNAPSHOT_ENTITY_ENC_CODE_VERSION` in `src/shared/cacheCodeVersions.js` is updated to match.

Measured in this pass:

- Commit `fa478a3` (push planned on the next tick, keyed by tick): 100 of 133 replays over 1 cm.
- Per-tick queue (first version of the sequence-keyed window): 4 of 27 replays over 1 cm, in 4 of 15 runs.
- Per-consumed-input queue: 2 of 31 replays over 1 cm, in 2 of 15 runs (maximum growth 0.2176 m). Pops 0 in every run.
- Per-consumed-input queue plus the idle accumulator removed: 6 of 23 replays over 1 cm, in 6 of 15 runs (maximum growth 0.2355 m). This is worse than the line above, so it is not yet confirmed as a fix. Phase B repeats the measurement before deciding.

Open after Phase A: the remaining over-limit replays are not explained yet. The step-level join points at (a) a client step that moves 40 mm off its velocity while `wedged` is true, from the client's wedge heuristic (`_updateServerBlock`, `WEDGE_TRAVEL_MIN_M`), and (b) a 2 to 3 mm vertical step difference near the 1.4 m ledge. Neither is a fix yet.

## Replay growth: Phase B (this pass)

Each change below is in the working tree, committed locally, then pushed in one push with the Phase A commits.

- Wedge test uses the predicted displacement (cause). `_updateServerBlock` in `src/client/PredictionEngine.js` judged the commanded travel as the sum of input velocities times the step `dt`. That is not the integral the step applies, so while the player turned or decelerated the sum read as motion, and the client flagged a wedge that was not there. The wedge then cut the client's step by up to about 40 mm. Fix: the commanded travel is the predicted position difference between the last acked entry and the entry `ackedTicks` later, from `history`. Falls back to no wedge when either entry is missing.
- Step-level capture, six runs at `--cond=50/10/2`: 2 corrections per run recorded, both at 0 growth. The wedge mismatch count from the step-level parser was not read reliably (its output format did not match the filter used), so the wedge change's own effect is not measured separately. It is measured only together with the earlier Phase A fixes below.
- Idle accumulator removal and per-consumed-input push queue (Phase A, now measured together with the wedge change): `npm run check` exit 0; `node scripts/groundy-replay-witness.mjs` (15 runs, 50/10/2 `on`), `RESULT: PASS the replay base groundY adds no growth over 1 cm in 15 runs of 50/10/2 (15 replays, max growth 0.0000 m, 0 run(s) with local pops)`, exit 0. Every run reports max growth 0.0000 m.
- Caveat: the witness samples one mover replay per run, so this is 15 replays in total, not every replay in the run. The earlier 6 of 23 figure came from the all-replay probe. The all-replay count for this build was not run, so the pass is evidence about the witness's mover, not a proof that no replay grows over 1 cm.
- Not separately measured: the wedge change alone, the accumulator removal alone. The 6 of 23 figure in Phase A was the per-consumed-input queue plus accumulator removal under the all-replay probe, before this wedge change. It is not a before-and-after for the final build.
- Residuals not explained: spawn y drop at seq 9 and 10 (client-only, 0.2 m, before the first correction) and the 1 to 2 mm ledge bounce at seqs 269 to 272 (below the bar). Not investigated in this pass. Left open.
- Repo note: `scripts/peer-replay-witness.mjs` was deleted in `8a201ff` (Phase A). The deletion was not separately approved; it follows from the removal of the client peer separation it tested.

## Replay growth: all-replay pass, Phase B results

Changes in this pass, each with its measurement:

- Witness covers every correction replay (`scripts/groundy-replay-witness.mjs`). It measures the `kind: correction` replays of all engines in each run, not one mover. `kind: resync` replays (first contact and the settle below) carry no ack error, so they are counted and not measured for growth. The coverage check is at its cause: a harness count of 0 asserts nothing, because the harness counts only the local engine and a correction on the other engine is not a miss; a non-zero count must match one engine's corrections (count and jump mean and max). Before this fix, run 13 failed on a correction on engine 1 that the harness does not count.
- Settle at the unchanged ack (cause of the spawn residual and of the 8 to 10 m error on engine 1). The server moves a player when its spawn hold releases, with no input acked (`ack 0`). Measured in a raw snapshot log: engine 0 moves z 8 to 10 and engine 1 moves z 8 to 0 at tick 17, with the ack still 0. `_reconcile` returned early whenever the ack had not advanced, so the client never adopted the move. Its first ack correction then carried the whole error: a 0.2 m drop (engine 0) and 8 to 10 m (engine 1) at ack 1. Fix (`src/client/PredictionEngine.js`, `_reconcile`): while the ack is 0 and unchanged, a server move above `RECONCILE_POS_EPS_M` re-bases with `_rebaseAndReplay(sv, null, false)`. The move is a resync, not a correction. Measured after the fix, three 20 s runs: 0 corrections in every run (before: 2 per run, errors 20 cm, 201 cm, 800 cm, 1000 cm at ack 1).
- Re-simulation of ungrounded steps (added in Phase A, reverted). Measured: the 0.2 m drop still appeared at the tile-arrival tick, because the client's floor was the server's own pre-settle state. The mechanism was not the cause. Removed.
- Ledge hypothesis (added in Phase A, reverted). A wedged step kept on the collider with the into-wedge velocity removed. Measured with the same blip count as without it: one one-tick spike of about 1 to 2 mm per run in both arms, so the change had no measured effect. The spikes are not from the mirror and analytic solver switch. Cause not found. Left open, and `src/shared/characterStep.js` is back at its `bae3c98` content.
- Wedge change, measured alone (displacement vs velocity sum, both arms with the settle fix, all-replay witness, 15 runs each):
  - Displacement (`true`, kept): `RESULT: PASS ... (0 replays, max growth - m, 0 run(s) with local pops)`. Zero correction replays in 15 runs.
  - Velocity sum (`false`): `RESULT: FAIL replay growth over 1 cm in 4 of 6 replays across 4 of 15 completed run(s)`. Over-limit runs 1, 4, 8 and 14, with growth 0.0981, 0.0335, 0.1462 and 0.0363 m.
  - The toggle and the velocity branch are removed after the measurement. The kept code is the displacement arm.
- Limit of the witness, stated so it is not read as more than it is: in this build the 20 s runs make no correction replays, so the witness passes on zero replays. The displacement arm's pass is therefore a pass with nothing to grow, and the all-replay count is 0, not a large sample.

## Witness power: contact scenario and the one-tick spike (Phase A, code and docs only)

Why: the displacement arm passed with 0 correction replays, so the witness measured nothing. The velocity arm's failures came from the same arena world with no contact, so they did not test the contact case either. The earlier 6 of 23 and 52 of 77 counts came from a contact case, and the current arena run has no corrections at all.

Changes in this phase:

- New harness world `peers` (`scripts/netcode-conditioner-harness.mjs`, `HARNESS_PEERS`). The mover walks forward, forward and right, backward, and backward and left, into an idle shooter placed at `[0, 1.2, 1.6]`, so the two players are in contact and the server's peer push applies. It uses the existing per-world `harness.script` and `harness.shooterAt`, and is registered in `INLINE_WORLDS`. Not measured yet; Phase B checks that it drives correction replays above zero. If it does not, the scenario is changed in Phase B, not the witness.
- The groundy witness defaults to `peers` (`scripts/groundy-replay-witness.mjs`). `--world=arena` still selects the old world.
- Power check: the witness's `--control` mode injects a 3 cm ack error into the mover and requires that the replays carrying it show growth above 1 cm. This is the existing test of whether the witness can see growth. Phase B runs it on `peers`.

The one-tick spike (1 to 2 mm up, then back down on the next tick, grounded, flat normal): investigated, cause not found in our code.

Measured facts:

- It is client-only. The server's own positions for the same player have no spike at the same ticks (0 spikes in three captures).
- It happens inside the collision mirror's Jolt step (`CollisionMirror.step`). Every grounded prediction step went through the collider (2290 of 2290 grounded steps), and the analytic path was not used.
- At the spike the tile swap and build counters are both 0, the tile count is unchanged, and the ground normal is `[0, 1, 0]`, so it is not a tile boundary.
- The static tile geometry is exact: each tile is the whole arena box (12 triangles), with top vertices at y = 0.000000 and bottom at y = -2.000000 in all 24 tiles received.
- Removing the mirror's `RefreshContacts` and `refreshGroundCaches` after a position sync does not stop the spike (with refresh: 0, 0, 2; without: 0, 2, 4 spikes in three runs each). So that refresh is not the cause.
- Spike occurrences are intermittent: 0 to 4 per run, at x and z values that differ by run.

Not checked: whether the Jolt character's walk-stairs step or a contact on the box's large triangles produces the lift. Left open. The spike is below the 1 cm witness bar, and it is a predicted-state blip that the ack does not correct.

## Witness power: Phase B, peers world under 120/40/6 (both arms, canonical 50/10/2)

Run: `node scripts/groundy-replay-witness.mjs` (world `peers`, condition `120/40/6`, 15 runs, 20 s each). Each run line now prints `[world <w> cond <c>]`, and the FAIL RESULT line names the world and condition too. The logs below come from before and after that change, so the first arm's log has no condition on its run lines.

Results (`correction` replays only; resync replays carry no ack error):

| Arm | Log | Replays | Over 1 cm | Runs over | Max growth | Contact replays over |
| --- | --- | --- | --- | --- | --- | --- |
| Displacement (committed `_commandedTravel`), first run | `/tmp/popdiag/final-arm-true.log` | 472 | 4 | 4 of 15 | 0.1096 m | 1 of 27 |
| Displacement, rerun with condition printed | `/tmp/popdiag/final-arm-true-cond.log` | 491 | 11 | 8 of 15 | 0.1110 m | 0 of 35 |
| Velocity sum (temporary branch, reverted) | `/tmp/popdiag/final-arm-false.log` | 492 | 48 | 14 of 15 | 3.4921 m | 0 of 31 |

The two displacement runs differ (472 and 491 replays, 4 and 11 over the limit) with the same code, so the count moves between runs. The velocity-sum arm is worse on every count: 48 over the limit against 11, and a max growth of 3.49 m against 0.11 m. The displacement formula stays in `src/client/PredictionEngine.js`. `FAIL` is still the result under 120/40/6: the displacement arm does not hold 1 cm.

Canonical 50/10/2 (`node scripts/groundy-replay-witness.mjs --cond=50/10/2`, log `/tmp/popdiag/canonical-50-10-2.log`, hook output `/tmp/groundy-replay-WjTxBA`): 14 runs have 0 correction replays. Run 7 has one correction replay, so the canonical result is not zero.

- Run 7, engine 1, seq 703: `errM` 0.0449 m, `jumpM` 0.1031 m, `growthM` 0.0582 m.
- `serverGroundY` 1.4 and `predictedGroundY` 1.3999999762, so the ground-Y gap is zero and the error is horizontal.
- `inContact` is false, so the peer push is not the cause.
- This is over the 1 cm limit. It is an open defect, and no cause is identified in this pass.

Open items:

- The displacement arm still grows past 1 cm in 4 to 8 of 15 runs under 120/40/6, up to 0.111 m. The cause is not found. Likely candidates are acks rejected by `ackUsable` or `maxAckAdvanceTicks`, which would leave prediction stale until a larger correction. Not tested in this pass.
- The canonical 50/10/2 run 7 correction (seq 703, 0.0449 m ack error, not in contact) is unexplained. The earlier 12-run hunt had no correction, so it appears only sometimes.
- The one-tick spike stays open, as described in the Phase A section above.

No defect was fixed in this pass. The pass changed only the witness output (world and condition on each line) and the harness's shooter script.

## Phase A: canonical 50/10/2 item and the 1–2 mm spike (code, docs and tests only, no build or witness run)

Changes in this phase:

- `scripts/groundy-replay-witness.mjs`: `MIN_REPLAYS = 100`. A PASS needs at least 100 correction replays across the runs. The canonical 50/10/2 condition yields 1 replay in 15 runs, so it cannot pass and is reported as `FAIL underpowered`. The gate condition stays `120/40/6`, the default since 7bb9e43.
- `scripts/lib/groundy-replay-hook.mjs`: wraps each engine's collision mirror `step` and records a `spike` record for each grounded step where y rises 0.8 to 2.5 mm and then falls at least 0.8 mm on the next step. Each record carries the engine id and the up and down amounts.
- `scripts/groundy-replay-witness.mjs`: resyncs are counted by `kind === 'resync'`, not by subtraction, so spike records are not counted as resyncs. Each run line and the totals print the mirror spike count. A PASS needs zero spikes, and `RESULT: FAIL` names the spike count when spikes are present.
- `docs/index.html`: regenerated with `node scripts/generate-docs-site.js`.

Canonical 50/10/2 item, status: the one correction (run 7, seq 703, ack error 0.0449 m, 0.0582 m growth, not in peer contact, ground-Y gap zero) is kept as a stated limit, not closed. The cause of that ack error is not identified. The witness no longer passes on that condition, because of the replay floor above.

Spike evidence. The spike is the 1–2 mm grounded lift in `CollisionMirror.step`. These counts come from the solver probe (`/tmp/popdiag/solver2.mjs`) and the ablation batches in `/tmp/spike/`, which are outside the repo:

- Baseline, no change to Jolt settings: 9 spikes in 31 live `peers` runs under `120/40/6` (2 in runs 1–11, then 7 in runs 12–31).
- `mStickToFloorStepDown` set to zero (`nostick`): 0 spikes in the same 31 runs. At about 0.29 spikes per baseline run, zero in 31 runs is unlikely by chance (about 9 expected).
- `mWalkStairsStepUp` set to zero (`nostep`): 6 spikes in 11 runs, against 2 in 11 for the baseline. Walk-stairs step-up is not the cause, and disabling it did not remove the spike.
- The positions of all 11 captured spikes (from `/tmp/popdiag/solver2-2.json` and the baseline captures) each sit one step past the line x = z, with |x − z| between 0.18 and 0.40 m. That matches the top-face diagonal of the arena box, but the next point shows the diagonal is not the cause on its own.
- A replay on the opposite diagonal gives a spike at the same step with the same 1.0854 mm lift.

Why the standalone replays do not count as evidence: a replay that starts each step from the logged `p0` already contains the lifted position from an earlier logged step, so the mirror passes the logged value through, and the result does not depend on the Jolt settings or the geometry. Every control in that matrix gave the same output. A replay started from a fresh Jolt state does not reproduce the logged step either. The mechanism therefore depends on Jolt state that the logs do not capture: the character's ground and contact state between steps.

Ruled out: the top-face diagonal alone; walk-stairs step-up (`nostep`); the mirror's contact refresh (removing it in an earlier pass did not remove the spike); tile swaps and builds (zero at each spike); tile geometry (the arena box tile is exact); the server (no spikes in three captures); float noise on the top face (a 1e-6 m height noise gave the same lift).

Supported: `mStickToFloorStepDown` (0.5 m) is required for the spike in the live runs. Removing it removes the spike, and it is the only setting tested that does.

Open: the mechanism inside Jolt's `ExtendedUpdate` that lifts the character before the stick pulls it back; a fix that keeps stick-to-floor and removes the lift; and whether `nostick` changes walking on downward steps, since it allows the character to leave the ground. The spike stays open. Phase B runs the witness, which now counts spikes, so the defect is measured in the gate.

## Phase B: spike decision on final code, canonical 50/10/2, server probe (open)

Final code: `715ab77` (Phase A) with the RESULT block in `scripts/groundy-replay-witness.mjs` now listing every failing reason, and the new `scripts/stick-floor-ramp-witness.mjs`. No `src/` change, so no bundle rebuild was needed for this pass. History: `origin/main` is 7bb9e43 (rewritten, see the note below), and this work sits on it as 715ab77 and the commit that carries this section.

Measured on the final code (all runs `peers`, `--predict=on`, 15 runs each unless noted):

- `npm run check`: exit 0.
- `node scripts/stick-floor-ramp-witness.mjs`: `RESULT: PASS the 0.5 m stick-to-floor keeps the character grounded on a 5 deg ramp (0.9355 >= 0.9); removing it drops grounded to 0.0645`. Log `/tmp/spike/C-ramp.log`.
- `node scripts/netcode-conditioner-harness.mjs --cond=120/40/6 --predict=on --world=peers --duration=20000 --out=/tmp/spike/C-harness.json`: exit 0, log `/tmp/spike/C-harness.log`.
- Gate, `node scripts/groundy-replay-witness.mjs` (120/40/6): exit 1. `totals: runs 15/15 replays 497 replays over 1 cm growth 11 (in peer contact 0 of 42 contact replays; with a groundY gap 0) in 10 run(s) max growth 0.1110 m ... mirror spikes 5`. `RESULT: FAIL world peers cond 120/40/6: replay growth over 1 cm in 11 of 497 replays across 10 of 15 completed run(s); 5 mirror one-tick spike(s) of 0.8-2.5 mm across 5 of 15 run(s)`. Log `/tmp/spike/C-groundy-120-40-6.log`.
- Canonical, `node scripts/groundy-replay-witness.mjs --cond=50/10/2`: exit 1. `totals: runs 15/15 replays 0 replays over 1 cm growth 0 ... mirror spikes 2`. `RESULT: FAIL world peers cond 50/10/2: underpowered: 0 correction replay(s), below the 100 needed to gate replay growth; 2 mirror one-tick spike(s) of 0.8-2.5 mm across 2 of 15 run(s)`. Log `/tmp/spike/C-groundy-50-10-2.log`. The earlier 50/10/2 run had 1 correction replay and this run has 0, so the canonical correction does not reproduce from run to run; the item is recorded as a stated limit (underpowered), not closed.
- Server-side spike probe (`/tmp/popdiag/nstick2.mjs` and `/tmp/popdiag/srvspike.mjs`, 120/40/6, three runs): `server spikes: 0` in each of three runs, about 2,600 server rows per run. The client rate is about 0.3 per run, so three runs with zero is weak evidence. Logs `/tmp/spike/C-srv-{1,2,3}.json`.

Spike decision, from the evidence:

- The trigger is the stick-to-floor step-down. Live ablation: 9 spikes in 31 baseline runs (`120/40/6`), 0 in 31 runs with `mStickToFloorStepDown` set to zero. Walk-stairs step-up is not the trigger: disabling it gave 6 spikes in 11 runs against 2 in 11 for baseline.
- Setting the stick distance to 0.1 m gave 5 spikes in 10 runs, and to 0.2 m gave 10 in 10. Shorter sticks do not remove the spike, so no distance setting is the fix.
- Removing the stick removes the spike, but it is not an acceptable fix. On the 5 deg ramp the grounded fraction falls from 0.9355 to 0.0645 (`scripts/stick-floor-ramp-witness.mjs`). A character walking down any slope would be airborne most of the way.
- Decision: keep `stickToFloorDistance` at 0.5 m, make no physics change, and gate the stick with `stick-floor-ramp-witness.mjs` so that removing it fails. The spike stays a counted defect in the replay gate (5 in 15 runs at 120/40/6).
- What is still unknown: the Jolt-internal mechanism. A fresh-state replay of a logged spike does not reproduce it, because each replayed step starts from the logged `p0`, which already carries the earlier lift. A standalone flat, step and ramp simulation at sprint speed (24 m/s, the captured speed) gives zero spikes in 3600 steps. So the spike is recorded as open at its trigger, not at its mechanism.

Other open defect: the 11 correction replays over 1 cm at 120/40/6 (max 0.111 m). Recorded with its cause unknown. The candidates from earlier passes are acks rejected by `ackUsable` or `maxAckAdvanceTicks`, which leave prediction stale until a larger correction. This pass did not test them.

Note on history: `origin/main` was rewritten to 7bb9e43 with admin@coas.co.za removed by owner approval. The Phase A commit is now 715ab77 on that base, under almagestfraternite@gmail.com. The earlier history on this ledger (7bb9e43 and before) is no longer on `origin/main`, so its commit hashes in this file refer to the old history.

## Phase A: replay growth at 120/40/6, instrumented (code, docs and tests only)

Top unblocked item: the correction replays over 1 cm at 120/40/6 (11 of 497 in the final-code gate run, max 0.111 m, `/tmp/groundy-replay-WRu6C4`, RESULT FAIL).

What the existing records already show (from `/tmp/groundy-replay-WRu6C4`, no new run):

- Every over-1 cm replay has an unacked replay length (`lastSeq − ackSeq`) of 14 or 15 inputs. Of the 497 corrections, 144 have a lag of 13 or less, and none of them exceeds 1 cm. At lag 14, 4 of 166 do, and at lag 15, 7 of 187 do.
- The over-limit replays have ack errors of 0.23 to 1.6 m, and all are on the local player's engine with no peer contact (`inContact` false) and a ground-Y gap of zero. So the growth is horizontal, and it is not the peer push.
- The server's input-catch-up path runs only when the queued inputs exceed `INPUT_BUFFER_CATCHUP_DEPTH` (8), and then at most `MAX_CATCHUP_STEPS_PER_TICK` (3) extra steps per tick, gated by `inputStepBudget` (`src/sdk/TickHandler.js` `processPlayerMovement`). A lag of 14–15 is consistent with a queue above 8.

Candidate under test: the server's catch-up steps and the client's replay disagree when the server queue is deep. This is a hypothesis, not yet a finding.

Changes in this phase (no `src/` change):

- `scripts/lib/groundy-replay-hook.mjs`: wraps `PlayerManager.prototype.getInputs` to read each player's input-queue length on every server tick, and `NetworkState.prototype.updatePlayer` to store that length by the server tick. Each correction record now carries `serverQueueDepth` (the queue length at the acked tick, or null if none was logged) and `ackAdvance` (how far the ack moved on that snapshot). The existing injection, spike and record fields are unchanged.
- `scripts/groundy-replay-witness.mjs`: the totals line adds `corrections with server queue above 8 N of which over 1 cm M`, so the run shows whether over-limit replays sit in the deep-queue regime.

Phase B will run the 120/40/6 gate once with these fields, then decide the fix from what the counts show. If the over-limit replays are not in the deep-queue regime, the hypothesis is refuted and the next candidate (ack rejection by `ackUsable`/`maxAckAdvanceTicks`, read from `ackAdvance`) is tested the same way.

## Phase B: replay growth at 120/40/6, candidates tested (open)

Runs on the instrumented hook (`scripts/lib/groundy-replay-hook.mjs`), `peers`, `120/40/6`, 15 runs each:

- Run D (first instrumented, `ackAdvance` read a stale value): `/tmp/spike/D-groundy-120-40-6.log`. Totals: `replays 485 ... growth 11 ... max growth 0.1282 m ... corrections with server queue above 8 115 of which over 1 cm 4`. RESULT FAIL.
- Run D2 (ack advance fixed, every ack recorded): `/tmp/spike/D2-groundy-120-40-6.log`. Totals: `replays 476 ... growth 7 ... in 6 run(s) max growth 0.0820 m ... mirror spikes 4 ... corrections with server queue above 8 116 of which over 1 cm 4`. RESULT FAIL.
- Run D3 (temporary probe: `MAX_CATCHUP_STEPS_PER_TICK = 0` in `src/sdk/TickHandler.js`, reverted after the run): `/tmp/spike/D3-groundy-no-catchup.log`. Totals: `replays 499 ... growth 4 ... in 4 run(s) max growth 0.0324 m ... corrections with server queue above 8 159 of which over 1 cm 0`. RESULT FAIL.

Candidates, with the evidence for each:

- Refuted as the discriminator: server input-queue depth. Over-limit replays sit at queue depths 1, 2 and 3 as well as above 8 (in run D, 5 of 11 at depth 1 to 3).
- Refuted: ack rejection. In run D2 there are 20,537 ack records: 8,677 applied, and every applied ack advanced by 1 to 8 inputs. The 11,860 skipped acks all have zero advance, which is a repeated ack. No advancing ack was rejected, so `ackUsable` and `maxAckAdvanceTicks` do not drop acks here.
- Associated, small counts: multi-step acks. In run D2, corrections on acks that advance by 4 inputs at once have 4 over-limit replays in 45 (about 9%); acks advancing by 1 or 2 have 3 in 360 (about 0.8%). The server's catch-up path is the mechanism that advances an ack by several inputs at once.
- Partial: catch-up. With catch-up off (run D3), over-limit replays fall to 4 in 499 from 7 in 476, and to 0 among the 159 deep-queue corrections. Four over-limit replays remain with catch-up off, so catch-up is at most one contributor.

Not tested: the replayed path itself (per-input server and client positions for a multi-step ack, the wedge state `horizontallyWedged` and `_blockedByServer` at the ack, and the push window). The next step is a per-input comparison for one over-limit replay.

Status: open. The growth cause is not identified. Phase A is `89fbd68`, and this phase adds the ack-advance fix to the hook. No `src/` change is kept.

## Phase A: replay growth per-input trace, check step and ledger hashes (code, docs and tests only)

Changes in this phase:

- `scripts/check.mjs`: adds `stick-floor-ramp-witness` to the step list (after `server-field-paint-host-witness`), so `npm run check` runs the 0.5 m stick ramp witness and fails if the grounded fraction on a 5 deg ramp drops below 0.9.
- `docs/PENDING_VALIDATION.md`: the commit hashes that are no longer on `origin/main` are replaced with the rewritten commit of the same subject (0197ebf to 7bb9e43, 096e298 to bae3c98, 54229e9 to a540e75, 8e44515 to 8a201ff, b66a1b5 to fa478a3, fa25370 to 715ab77). Each mapping was checked by exact subject match. A note at the top of the file records the mapping.
- `scripts/lib/groundy-replay-hook.mjs`: four additions, each a wrapper that returns the wrapped call's value unchanged.
  - Server per-input positions. `PhysicsIntegration.prototype.updatePlayerPhysics` is wrapped. After each call the hook records the player's state position under `playerId|ackSequence`, where `ackSequence` is the sequence `takeNextInput` set for that step (first record per key only). A step with no consumed input is not recorded.
  - Client pre-replay path. Each correction stores `prePath`, the input history before the replay, next to `path`, which is the history after it.
  - Wedge and push state at the ack. Each correction stores `wedge` (`horizontallyWedged`, `blockedByServer`, `wedgeNormal`) and `push` (the server snapshot's `pushWindow` and `pushAckSeq`), both read before the replay.
  - Per-input trace. At exit, each correction and resync gets `trace`: for every input after the ack, `pre` (the client's pre-replay position), `post` (the replayed position) and `server` (the server's position after that input, or null if the server had not processed it by exit).
- `scripts/groundy-replay-witness.mjs`: each over-limit correction prints one line with its ack, lag, ack advance, queue depth, error, growth, wedge and push state, and the first input where the pre-replay prediction is more than 1 cm off the server and the first input where the replay is more than 1 cm off the server. The full traces of all over-limit corrections are written to `over-limit-traces.json` in the run's temporary directory, and the path is printed.

Question this phase is built to answer: for one multi-step over-limit replay, does the client or the server diverge first? The server cannot see unacked inputs when the ack arrives, so the server positions for inputs after the ack are recorded when the server later processes them, and joined at exit.

## Docs index

`docs/index.html` was regenerated with `node scripts/generate-docs-site.js` after the `netcode.md` and `navmesh-pathfinding.md` edits, because the generator reads spoint's `docs/*.md`. It is a generated file, so check it again if either doc changes.

## Phase B: replay growth at 120/40/6, per-input cause (fix decision open)

Runs on the instrumented hook (`scripts/lib/groundy-replay-hook.mjs`), `peers`, `120/40/6`, 15 runs each. `RESULT` lines are quoted from the run output.

- Gate F (Phase A hook, `8953547`, first-physics-call server positions): log `/tmp/spike/F-groundy-120-40-6.log`, traces `/tmp/groundy-replay-OBoQo6/over-limit-traces.json`. Totals: `replays 454 replays over 1 cm growth 4 (in peer contact 0 of 34 contact replays; with a groundY gap 0) in 4 run(s) max growth 0.0708 m ... mirror spikes 5 ... corrections with server queue above 8 97 of which over 1 cm 0`. `RESULT: FAIL world peers cond 120/40/6: replay growth over 1 cm in 4 of 454 replays across 4 of 15 completed run(s); 5 mirror one-tick spike(s) of 0.8-2.5 mm across 4 of 15 run(s)`.
- Gate G (this pass's hook, every server physics call recorded with its `dt`): log `/tmp/spike/G-groundy-120-40-6.log`, traces `/tmp/groundy-replay-vxWCzE/over-limit-traces.json`. Totals: `replays 480 replays over 1 cm growth 10 (in peer contact 0 of 31 contact replays; with a groundY gap 1) in 10 run(s) max growth 0.0607 m ... mirror spikes 5 ... corrections with server queue above 8 98 of which over 1 cm 0`. `RESULT: FAIL world peers cond 120/40/6: replay growth over 1 cm in 10 of 480 replays across 10 of 15 completed run(s)`.

Per-input comparison (what the question asked: which side diverges first, and the wedge and push state at the ack):

- Wedge and push state are identical in every over-limit replay: `horizontallyWedged` false, `blockedByServer` false, `wedgeNormal` [0,0], and the push window is all null. So neither the wedge nor the peer push is involved. Peer contact is 0 in every over-limit replay.
- Every physics call in the traces I inspected (ack 250, 251, 249, 312 and 310) has `dt` 0.0167 s, the nominal tick. Tick dilation is therefore not the cause in those replays. I did not check the other over-limit traces for `dt`.
- Class A, 8 of 10 (ack 249 to 251, lag 14, queue 6 to 7, growth 0.012 to 0.022 m): the replay tracks the server within 3 to 5 mm at every input the server had consumed before the last one. The client's pre-replay prediction had drifted 0.015 to 0.022 m further from the server over the 14-input unacked window, and the growth metric (`offsetM - errM`) counts that drift. The replay adds no error here, so this is a metric effect. In the same runs the last consumed input key has 3 or 4 extra physics calls (`serverCallCount`), with `dt` 0.0167 each. Those are server ticks taken after its input queue ran dry, and they move the character about 0.41 m with no client-side input to replay. The server diverges from the client after the last input, not inside the replayed path.
- Class B, 2 of 10 (run ack 312, lag 15, queue 1; run ack 310, lag 14, queue 2; growth 0.059 and 0.061 m): the server has 2 physics calls under one input key (seq 315 and seq 311). The second call is a starved tick, taken before the next input arrived, and it moves the character about 0.22 m. The client replays one step per consumed input, so the replay is 0.22 m off from that input onward (`post-srv` 0.2243 at seq 311, 0.2166 at seq 318). The server diverges first, and the replay follows the inputs. The next ack corrects a 0.2 m residual.
- Deep queue is not the discriminator: over-limit replays at queue 1 and 2 in class B, and at 6 and 7 in class A. Corrections with queue above 8 have 0 over-limit in both gates.

Cause: the over-limit flags come from two sources, and neither is an error in the replay path itself. (a) The growth metric counts the client's prediction drift over the unacked window (class A). (b) The server runs physics ticks with no input (queue dry; `starveHoldTicks` then a neutral step, `src/sdk/TickHandler.js` `processPlayerMovement`), and the client's prediction has no step for them, so a 0.2 m or 0.4 m server-side displacement appears at the next ack (class B, and the last-key calls in class A).

Changes in this pass:

- `scripts/lib/groundy-replay-hook.mjs`: the server record is now the position after the last physics call under each input key, and every physics call is kept with its `dt` as `serverCallPositions` and `serverCallDts`, plus `serverCallCount`. Phase A recorded only the first call per key, which hid the extra starved ticks. The witness output line (`replay first off server at seq N`) now uses the end-of-key position, so its values differ from Phase A.

Not changed this pass (decision open, recorded here rather than left implicit):

- Fix for class B: the server's starved-tick step is a netcode behaviour choice. Options: (1) with no input available, hold the character (no physics step) so the client's per-input prediction matches; (2) keep the neutral step and have the client predict it. Option 1 freezes the character during packet loss, so the owner decides.
- The gate metric: `growth = offsetM - errM` measures prediction drift over the unacked window as well as replay error. The replay-error measure would be the replay residual against the server at consumed inputs (about 4 mm here). The owner decides whether the gate uses that measure.

Server spike probe (item 2, unchanged by this pass): `node /tmp/popdiag/srvspike.mjs` on `/tmp/spike/F-srv-1.json`, `F-srv-2.json`, `F-srv-3.json`, each from `NS_OUT=... node --import /tmp/popdiag/nstick2.mjs scripts/netcode-conditioner-harness.mjs --cond=120/40/6 --predict=on --world=peers --duration=20000`, gave `server spikes: 0` in all three.

`npm run check`: exit 0. The stick-floor ramp witness is in the output: `check: RESULT: PASS the 0.5 m stick-to-floor keeps the character grounded on a 5 deg ramp (0.9355 >= 0.9); removing it drops grounded to 0.0645`. Final line: `check: all app(s) resolve every import`. Build: not run, because this pass changed only `scripts/lib/groundy-replay-hook.mjs` and no `src/` file.

Status: replay growth over 1 cm at 120/40/6 is explained (class A metric drift, class B server starved ticks), and the fix for class B is an owner decision. Stick-to-floor trigger, canonical 50/10/2 and server spike rate are unchanged from the previous section.

## Phase A: starved tick steps neutral; gate on replay residual (120/40/6 close-out)

Decision 1, netcode (owner): a starved tick takes the server's neutral physics step at once, with no 0.25 s hold. Decision 2, gate (owner): pass or fail is the replay residual; `offsetM - errM` is recorded as a diagnostic only. 50/10/2 stays a stated limit: below `MIN_REPLAYS` (100) it reads `underpowered` and does not gate.

| Row | Change | Commit | Files | Witness to run in Phase B |
|---|---|---|---|---|
| netcode | `processPlayerMovement` takes the neutral step on every starved tick. `STARVE_HOLD_SECONDS` and `starveHoldTicks` are removed, and the step budget accrues every tick. | Phase A | `src/sdk/TickHandler.js`, `docs/netcode.md` | `node scripts/groundy-replay-witness.mjs` (120/40/6, 15 runs), `npm run check`, server probe |
| gate | The hook records `residualM` per correction: the largest distance from a replayed entry's position to the server's position right after that input was consumed (first physics call under its key). The witness gates on `residualM > 1 cm`. `growthM` (`offsetM - errM`) is printed as a diagnostic. | Phase A | `scripts/lib/groundy-replay-hook.mjs`, `scripts/groundy-replay-witness.mjs` | `node scripts/groundy-replay-witness.mjs` (120/40/6); `node scripts/groundy-replay-witness.mjs --control` must show residual over 1 cm |

Not done in Phase A: the client does not predict a starved tick live, because it cannot know one before the ack. The ack's replay base is the server state at the snapshot tick, so it already holds the neutral steps before that tick. Neutral steps after the snapshot are unknown until the next ack, and the residual is what shows them. Phase B decides whether that residual is acceptable or needs a wire change.

## Phase A (run 2): starved-tick count in the ack; client roll-forward

Decision (replaces the client-predicts-starved-ticks idea, which cannot work because the client learns of a starved tick only at the ack): the server keeps the 0.25 s hold and reports `starvedSteps`, the neutral physics steps taken since the acked input, in every ack. The client rolls forward from its prediction at the acked input through that many neutral steps and keeps that state if it agrees with the server within `RECONCILE_POS_EPS_M`; otherwise it rebases on the server state at the snapshot tick. Reason in `docs/netcode.md` (Input). The server state at the snapshot tick already includes the steps before it, so the client never replays them twice.

| Row | Change | Commit | Files | Witness to run in Phase B |
|---|---|---|---|---|
| count | `processPlayerMovement` counts neutral steps (not hold ticks) into `player.starvedSteps`, reset on each consumed input; `updatePlayer` takes it as a trailing argument. | Phase A | `src/sdk/TickHandler.js`, `src/netcode/NetworkState.js` | `node scripts/groundy-replay-witness.mjs` (120/40/6): the hook's `ackKeyCalls` and the gate totals; `npm run check` |
| wire | `encodeSelfBlock` appends `starvedSteps` at index 5 of the self block; `decodeSelfBlock` and `applySelfBlock` read it, defaulting to 0. Older decoders ignore index 5. | Phase A | `src/netcode/SnapshotEncoder.js`, `src/client/SnapshotProcessor.js` | `npm run check` (msgpack and snapshot witnesses); the gate reads the count on every ack |
| client | `_rebaseAndReplay` rolls forward from the acked prediction through the count (`_rollForwardAcked`) and falls back to the server base when it disagrees by more than `RECONCILE_POS_EPS_M`. | Phase A | `src/client/PredictionEngine.js` | `node scripts/prediction-reconcile-witness.mjs` (expect PASS, 22 checks); `node scripts/groundy-replay-witness.mjs` |
| probe | The hook records `ackKeyCalls`: the server's physics calls under the acked input key, including the starved steps that come after the snapshot. The 32 no-starve divergences are classified against it in Phase B. | Phase A | `scripts/lib/groundy-replay-hook.mjs` | `node scripts/groundy-replay-witness.mjs` (the traces carry `ackKeyCalls`) |

## Phase B: 120/40/6 close-out (netcode decision refuted and reverted; residual gate FAILS, cause partly identified)

Runs: `node scripts/groundy-replay-witness.mjs` (world `peers`, 120/40/6, 15 runs of 20 s), and the server probe below. Logs are in `/tmp/phaseB/` and are not tracked.

Decision 1, neutral physics step on every starved tick with no hold (commit `829b7fd`): REFUTED and reverted in `8cf1f10`.
- Gate on `829b7fd`: `totals: runs 11/15 replays 2136 replays over 1 cm residual 1961 (in peer contact 55 of 55 contact replays; with a groundY gap 1) in 11 run(s) max residual 4.6090 m`. `RESULT: FAIL world peers cond 120/40/6: 4 of 15 run(s) failed; replay residual over 1 cm in 1961 of 2136 replays across 11 of 11 completed run(s)`. Four runs failed the hook check (`failed: run 4: no engine's corrections match the harness's 94 applied corrections, so the hook missed a correction`, and runs 10, 13, 14).
- Local pops: `max pops/min 512.75` on that run. Per-ack error (`errM`) reached about 2.0 m.
- Cause: a starved tick with no movement keys moves the character on the server, and the client cannot predict a starved tick before the ack. Every starved tick became an error. The 0.25 s hold keeps the replay at about 31 to 35 replays per run, as on the pre-change code.

Decision 2, gate on the replay residual (commit `a9196d3`): implemented; the gate still FAILS on the reverted code (`8cf1f10`).
- `totals: runs 15/15 replays 499 replays over 1 cm residual 66 (in peer contact 29 of 29 contact replays; with a groundY gap 2) in 15 run(s) max residual 1.2887 m injected replays 0 (over limit 0) runs with local pops 15 max pops/min 170.96 pops 698 matched 286 in peer contact 9 mirror spikes 5`
- `RESULT: FAIL world peers cond 120/40/6: replay residual over 1 cm in 66 of 499 replays across 15 of 15 completed run(s); 5 mirror one-tick spike(s) of 0.8-2.5 mm across 5 of 15 run(s); 15 requested, 15 run(s) with local pops`
- The witness target (over-limit replays drop to zero or are explained by the residual) is not met: 66 replays are over the limit, in all 15 runs.
- Cause, from the traces (`/tmp/groundy-replay-x9V219/over-limit-traces.json`, counted by an ad hoc script, not committed): 36 of 66 over-limit replays have a starved server tick in their trace. 34 of 66 diverge from the server only after a starved tick. 32 of 66 diverge with no starved tick before the divergence, at 0.05 to 0.66 m. Every one of the 29 contact replays is over the limit. The 32 no-starve cases and the contact cases are not explained yet.
- The "about 4 mm" residual from the earlier ledger is not reproduced by this residual definition (the largest distance from a replayed entry to the server position at its consumption, over all replayed entries). The 4 mm figure was a class-A subset and is not the gate measure.
- Stated limit, not run: 50/10/2 is underpowered (`MIN_REPLAYS` 100, and it yields about 1 replay in 15 runs). It is reported as `underpowered` and does not gate.

Server probe (`/tmp/popdiag/srvspike.mjs` over three `nstick2.mjs` logs from `netcode-conditioner-harness.mjs --cond=120/40/6 --predict=on --world=peers --duration=20000`): `/tmp/phaseB/S-srv-1.json server spikes: 0`, `S-srv-2.json server spikes: 0`, `S-srv-3.json server spikes: 0`.

Build: `npm run build:bundles` wrote `dist/client` (`[bundle-client] stamped dist/client/app.bundlehash.json 26483c363bcaa80b`) and `dist/src/sdk/WorkerEntry.js` (`[bundle-worker] stamped dist/src/sdk/WorkerEntry.bundlehash.json 3126f402fca21ab2`). One esbuild warning, an empty glob for `./TickHandler.js?hmr=` in `src/sdk/WorkerEntry.js`, existed before this change.

`npm run check`: the first run failed on `RESULT: FAIL docs/index.html is not the generator output`, because the ledger edit changed `docs/*.md`. Fixed by `node scripts/generate-docs-site.js` and confirmed by `RESULT: PASS docs/index.html equals the output of scripts/generate-docs-site.js for the current sources`. The full re-run result is in the commit message and the report.

Status: Decision 1 refuted, reverted. Decision 2 implemented; the gate FAILS with the cause above. Open: the 32 no-starve divergences and the 29 contact replays.
