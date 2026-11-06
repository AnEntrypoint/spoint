# DESIGN.md

Design facts that do not fit AGENTS.md. Rules stay in AGENTS.md. A fact moves here only after its source comment is removed. Code is cited by path and symbol, never by line number.

## Netcode modules

Exports of the modules in `src/netcode/`, read from each module's export statements. Purposes are not listed here until each one is read against its code.

| Module | Exports |
|---|---|
| CheatEjection.js | wireCheatEjection |
| CollisionSystem.js | separationPush, applyPlayerCollisions |
| CollisionTileStreamer.js | COLLISION_TILE_RING, COLLISION_TILE_FORGET_RING, collisionMirrorEnabled, createCollisionTileStreamer |
| ConsensusVoter.js | DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED, ConsensusVoter |
| controlFrame.js | LOCKSTEP_CTRL_PREFIX, ROLLBACK_CTRL_PREFIX, CONSENSUS_CTRL_PREFIX, controlFrameKinds, encodeControlFrame, parseControlFrame, controlFrameHandlers, countReject, countOrder, createFrameClock, advanceFrameClock, dispatchControlFrame |
| DesyncDetector.js | DEFAULT_CHECKSUM_INTERVAL_TICKS, DesyncDetector |
| EventLog.js | EVENT_LOG_KINDS, parseEventKind, EventLog |
| Hitscan.js | DEFAULT_HITBOX, normalizeShotDirection, resolveFireRequest, resolveTargetPoint, rayVsCapsule, hitHeightRatio, findHitLinear, findHitSpatial, buildLiveIndex |
| InputGuard.js | isInputRateLimited, clearInputBucket, sanitizeInputPayload, envelopeSpeedCap, enforceMovementEnvelope |
| LagCompensator.js | LagCompensator |
| LockstepChecksum.js | createChecksumFold, checksumBodies |
| LockstepGameLoop.js | LOCKSTEP_DEFAULTS, INPUT_RETAIN_TICKS, createLockstepGameLoop |
| LockstepInputTransport.js | LockstepInputTransport, createLockstepInputTransport |
| LockstepTickSystem.js | LockstepTickSystem |
| NetcodeProfile.js | NETCODE_PROFILES, DEFAULT_MIN_PEERS, resolveNetcodeProfile, PEER_SIMULATED_PROFILES |
| NetworkState.js | NetworkState |
| OutlierDetector.js | recordHit, clearOutlierWindow |
| peerLoops.js | PEER_LOOP_FACTORIES, PEER_SIMULATED_PROFILES |
| PeerSimSession.js | createPeerSimSession |
| PhysicsIntegration.js | PhysicsIntegration |
| PlayerManager.js | PlayerManager |
| ReplayFile.js | SPOINTREPLAY_MAGIC, SPOINTREPLAY_VERSION, encodeReplay, decodeReplay |
| ReplayPlayer.js | ReplayPlayer |
| ReplayRecorder.js | ReplayRecorder |
| RewindSpatialIndex.js | REWIND_SLOP, RewindSpatialIndex, DEFAULT_REWIND_CELL_SIZE, DUPLICATE_PLAYER_ID, RewindDuplicatePlayerIdError, buildLiveIndex |
| RollbackGameLoop.js | ROLLBACK_DEFAULTS, createRollbackGameLoop |
| RollbackInputTransport.js | RollbackInputTransport, createRollbackInputTransport |
| RollbackLoop.js | createRollbackLoop |
| SnapshotBinFormat.js | BIN_RECORD_BYTES, POS_I32_MAX, SCALE_U16_MAX, clampI16, clampI32Pos, clampU16Scale, PLAYER_TIER_FULL, PLAYER_TIER_REDUCED, REDUCED_POSE_FIELDS, REDUCED_HEIGHT_ABSENT, packReducedPlayerPose, unpackReducedPlayerPose, makeReducedPlayerPose, isReducedPlayerPose, packBinRecord, PLAYER_BIN_RECORD_BYTES, packPlayerBinRecord, unpackPlayerBinRecord, unpackBinRecord, packQuat, unpackQuat |
| SnapshotEncoder.js | encodeSelfBlock, decodeSelfBlock, PLAYER_LOD_FULL_COUNT, PLAYER_LOD_REDUCED2, PLAYER_LOD_REDUCED_HZ, buildCrowdDots, classifyPlayerTiers, filterEncodedPlayersTiered, TombstoneLog, encodeEntity, encodeCustomBySchema, decodeCustomBySchema, PROP_MAX_HZ, PROP_SLEEP_TICKMOD, propTickMod, primeEntryDecode, updateTombstones, SnapshotEncoder, unpackBinRecord, packQuat, unpackQuat, PLAYER_TIER_FULL, PLAYER_TIER_REDUCED |
| SnapshotPacker.js | snapshotPackCounts, newRecordMemo, packSnapshotBytes |
| TeleportHold.js | TELEPORT_HOLD_MAX_MS, beginTeleportHold, stepTeleportHold |
| TickSystem.js | TickSystem |
| TickSystemBase.js | TickSystemBase, probeTimerGranularity |
| WorkerBridgeProxy.js | createWorkerBridgeProxy |

Open (owner, from the savi gaps file section 6): whether docs/netcode.md gets a section for these modules.

## Lag compensation

Source: `src/netcode/LagCompensator.js` and `src/netcode/Hitscan.js`.

- `HISTORY_CAPACITY = 256` samples per player. Writes past capacity overwrite the oldest sample.
- `historyWindow` is in milliseconds. `windowTicks = round(historyWindow * tickRate / 1000)`. The default is 1000 ms, which is 60 ticks at tickRate 60.
- `SPOINT_LAG_HISTORY_WINDOW` overrides the window.
- `FUTURE_TOLERANCE_TICKS = 1`: a reported tick more than one tick ahead is rejected.
- A reported tick older than the retained range is clamped to the oldest retained tick.
- Rewind token bucket: capacity 10, refilled at 20 per second.
- Origin drift limit: 2 m by default.

Overflow before the fix (measured with /tmp/lag-overflow/run.mjs, 300 samples at 60 Hz): a 5000 ms window filled the ring and the oldest stored tick was 44. A rewind to tick 0 resolved to 0 with the clamp counter not rising, so the overflow was silent. A 4267 ms window gave a clamp target of 43 while the sample returned was tick 44.

Fixed in a17c719: the clamp uses `retainedTicks = min(windowTicks, HISTORY_CAPACITY - 1)`, and `rewindAtTick` returns the stored sample's tick. `scripts/lag-overflow-witness.mjs` pins 4000 ms, 5000 ms and 4267 ms.

## Wire format

Source: `src/netcode/SnapshotBinFormat.js` and `src/netcode/SnapshotEncoder.js`.

- `BIN_RECORD_BYTES = 29` and `PLAYER_BIN_RECORD_BYTES = 22`. The wire check that pins them is `/tmp/wire-layout/check.mjs` (5 assertions, PASS in the run that produced this section).
- `packQuat` uses a smallest-three layout: a 2-bit index for the largest component and three 10-bit fields. The scale is `QSCALE = 511 * sqrt(2)`.
- Range: position is clamped to the signed 32-bit range `POS_I32_MAX`, velocity to i16, scale to u16 via `SCALE_U16_MAX`. A non-finite or out-of-range value throws `RangeError`.
- `PLAYER_TIER_REDUCED = 1`.
- Pitch is one byte over [-pi/2, pi/2] and yaw is one byte over a full turn. Both sit in one 16-bit field (`SnapshotEncoder.js`).
- The self block carries inputSequence, the input depth, the ground normal and the wall planes (`SnapshotEncoder.js`).
- `WIRE_UNITS_PER_METER = 100` is used only in `SnapshotBinFormat.js`.

## Snapshot packer

Source: `src/netcode/SnapshotPacker.js`.

- `snapshotHead` is memoised once per process. The memo is valid only while `WIRE_STRUCTURES` in `src/protocol/msgpack.js` is fixed.
- Player records are packed once per memo, not once per viewer.

## Client prediction chart

Source: `src/client/PredictionChart.js`.

Hot swap: every export in `PredictionChart.js` is a pure function over its arguments. `groundScratch` is a per-call scratch buffer that every call overwrites before reading, so a swapped-in copy starts from the same observable state. An ESM import is a live binding to the instance's export bindings, so every importer that already holds them reads the new code on its next call.

## Player identity

Source: `src/game/playerId.js`.

Every system keys its maps on the parsed value. No function accepts the raw one.

## Input acknowledgement sequence

Source: `src/netcode/PlayerManager.js`, `ackSequenceOf`.

The sequence addInput compares against is published by `ackSequenceOf`, so a decode can walk past the records it would otherwise build an object for and then have addInput drop on this same comparison.

## Dev HMR body validators

Source: `src/sdk/DevHmr.js`, `moduleValidator`.

A ?hmr= body is a pure function of the file's bytes, the floor, and the active version of the module itself and of each of its direct imports. `rewrite()` stamps an import only while that import carries a version above the floor. So those are exactly what a validator must cover, and a body is re-sent only when one of them moves. `Cache-Control: no-cache` still forces a revalidate before every use, so a reload answers 304 and never re-reads or re-rewrites the source. Only the modules an edit reaches pay for a body.

## Near-field lattice

Source: §src/terrain/NearFieldLattice.js§. Text moved from the file header and its inline comments, paragraph order kept.

The near-field lattice: ONE regular grid at the collider's spacing, from which the rendered near band is built. The collider already builds that spacing -- see src/shared/colliderLattice.js -- so the ground the player walks on and the ground the player sees are two draws of one density instead of two independent samplings of one height field.

The band is PLAYER-CENTRED and its extent is the collider's own field, not a subdivision of whichever quadtree leaf the player happens to be standing in. That is what makes the band the same ground at every quality tier: a band derived by subdividing the host leaf can only cover floor(budget / divisions^2) leaves, so at the tier where the host leaf is one whole budget of tiles it covers exactly ONE leaf -- a ~62 m island of collider-resolution ground in a field of leaves whose spacing is whatever maxLevel happens to allow. Deciding the band's extent from the collider instead of from the leaf is the whole difference, and it is why extentM is required here rather than defaulted.

It is a PLAN over the renderer's own shared patch geometry, not a new coordinate system and not a second mesh: a tile is drawn exactly as a quadtree leaf is drawn -- same instances, same vertex stage, same skirt -- so this introduces no second material and no second shader path.

Nothing here knows about WebGPU, quads or shaders, so scripts can measure it with no GPU at all.

How many tiles one dropped leaf may cost. The quadtree's near-field floor is one leaf of tileM * floor(sqrt(tileBudget)): the largest leaf the band can still cover, so a leaf bigger than it is never dropped and the band steps around it instead. This is a bound on the cost of REPLACING one leaf, never a bound on how much ground the band covers -- coverage is the collider's extent, and a band that cannot afford the collider's whole extent reports the shortfall instead of silently covering less.

One tile wide: the widest leaf the band's rim may abut is a leaf the SAME size as a tile, so the ground past the rim is drawn at the band's own spacing instead of one quadtree level coarser. The rim step is bounded by the COARSER of the two surfaces, so a rim meeting 2.00 m ground against 1.00 m tiles is bounded by the 2.00 m side and no property of the band can shrink it -- that is what measured 0.11113 m at every tier (scripts/nearfield-lod-lattice-witness.mjs, perimeterJump, max over ~1004 samples of the footprint perimeter, identical at all 8 tiers because the band and the floor-refined ground past it are identical at all 8 tiers). At one tile wide the coarse side IS the band, so the step collapses onto the band's own faceting.

The cube-sphere map is not conformal: one face-local metre is 0.780 m of ground along u and 0.617 along v at the tps-game anchor, and it drifts with position on the face. The floor is a length in FACE-LOCAL metres while the band's extent is metres of GROUND, so a reach derived from the band's extent is divided by the ground-per-face-metre the map shows where the player stands. The SMALLEST the map can show is the fallback a caller with no measured metric uses: dividing by it gives the largest face-local reach, so the floor still reaches the rim wherever the player stands.

A tile is gridSteps intervals of the collider's spacing, so a tile's step IS the collider's step -- the whole claim: the near band can never be coarser than the surface it replaces.

The quadtree must offer a leaf the band can cover, or there is no band. That is a floor on the quadtree's near-field subdivision, derived here in metres and read by Quadtree, so the two cannot disagree about how fine the near band's leaves are.

How wide the band can get: a whole number of tiles, capped so a step of distance tessellation cannot drag the rim outward with the LOD and migrate the ridge when quality is shed.

The floor's reach, in FACE-LOCAL metres, from the band's OWN footprint rather than from a level count or a fixed radius: the floor's whole job is one leaf of ground past the band's rim, so the reach is the rim plus that leaf and nothing else.

OUTER: the band is snapped to its own tile grid rather than centred on the player, so its rim can sit a whole tile further from the camera than the band's half-extent; and a face-local reach buys least GROUND where the map stretches least, so the reach is divided by the SMALLEST metric the map shows. Measured at the tps-game anchor: 0.780 m of ground per face-local metre along u and 0.617 along v, so a reach converted with the larger of the two stops about 20 m of ground short of the rim along v -- which is a rim that meets the far field after all, and it measured 0.483 m against the 0.0626 m the floor exists to hold. The reach is PER AXIS, so it is the half-extent and not the half-extent times sqrt(2): the square's corner is already inside it.

INNER: the band drops every leaf it covers WHOLE, so everything more than one leaf inside the rim is ground the band throws away -- 66% of the leaves the whole-footprint floor added, all of it where the tiles are drawn anyway. The floor therefore refines the RIM ANNULUS. The inner reach is derived from the metric the band is laid out in, because that is the only way it can be one leaf inside the rim and not somewhere else: past one leaf the leaves stop being smaller than the band, so they stop being droppable, and the tiles they suppress are the near field's own resolution.

The reach for a caller with no metric to measure: the map's smallest ground-per-face-metre gives the largest face-local reach, so the floor still reaches the rim wherever the player stands. It carries no inner reach, because an inner reach is only safe when it is derived from the same metric the band is laid out in -- the conservative outer is wider than the band, so subtracting a leaf from it would leave the hole wider than the band and the tiles would start being suppressed.

leaves: the quadtree's leaves, each { ox, oy, l }. camera is the player in the same face-local metres. instanceBudget caps the band's tile count at the number of instances the terrain payload it joins already spends, so the band can never cost more than the ground it replaces is worth at this tier; when that is less than the collider's extent the shortfall is reported. groundPerFaceMetre: how many metres of GROUND one face-local metre is at the band, from the cube-sphere map's own metric. spacingM and extentM are metres of ground -- they are the collider's -- but the tile grid is laid out in face-local metres, so without this the band draws at 0.698 m where the collider is 1.00 m and covers 89 m of ground where the collider's field is 256 m: the same number of tiles, a third of the ground, and a spacing that drifts with where on the face the player stands. Measured in the shipped client, TOD pinned.

The band is snapped to the collider's own grid so its vertices do not swim with the camera: moving by less than a tile moves nothing, moving by a tile moves the band by a whole tile.

A leaf is dropped only when the band covers it WHOLE; a leaf straddling the rim is kept, and every tile inside a kept leaf is suppressed. That is what keeps the band free of both a hole (a dropped leaf nothing fills) and a doubled surface (a kept leaf the band also draws).
