# DESIGN.md

Design facts that do not fit AGENTS.md. Rules stay in AGENTS.md. A fact moves here only after its source comment is removed. Code is cited by path and symbol, never by line number.

## Netcode modules

Exports of the modules in `src/netcode/`, read from each module's export statements. Purposes are not listed here until each one is read against its code.

| Module | Exports |
|---|---|
| CollisionTileStreamer.js | createCollisionTileStreamer, COLLISION_TILE_RING, COLLISION_TILE_FORGET_RING, collisionMirrorEnabled |
| EventLog.js | EventLog, EVENT_LOG_KINDS, parseEventKind |
| Hitscan.js | DEFAULT_HITBOX, normalizeShotDirection, resolveFireRequest, resolveTargetPoint, rayVsCapsule, hitHeightRatio, findHitLinear, findHitSpatial, buildLiveIndex |
| InputGuard.js | isInputRateLimited, clearInputBucket, sanitizeInputPayload, envelopeSpeedCap, enforceMovementEnvelope |
| LockstepChecksum.js | createChecksumFold, checksumBodies |
| LockstepGameLoop.js | LOCKSTEP_DEFAULTS, INPUT_RETAIN_TICKS, createLockstepGameLoop |
| LockstepInputTransport.js | LockstepInputTransport, createLockstepInputTransport |
| NetcodeProfile.js | NETCODE_PROFILES, DEFAULT_MIN_PEERS, resolveNetcodeProfile, PEER_SIMULATED_PROFILES |
| OutlierDetector.js | recordHit, clearOutlierWindow |
| PeerSimSession.js | createPeerSimSession |
| peerLoops.js | PEER_LOOP_FACTORIES, PEER_SIMULATED_PROFILES |
| ReplayFile.js | SPOINTREPLAY_MAGIC, SPOINTREPLAY_VERSION, encodeReplay, decodeReplay |
| ReplayRecorder.js | ReplayRecorder |
| ReplayPlayer.js | ReplayPlayer |
| RewindSpatialIndex.js | REWIND_SLOP, RewindSpatialIndex, DEFAULT_REWIND_CELL_SIZE, DUPLICATE_PLAYER_ID, RewindDuplicatePlayerIdError, buildLiveIndex |
| RollbackGameLoop.js | ROLLBACK_DEFAULTS, createRollbackGameLoop |
| RollbackInputTransport.js | RollbackInputTransport, createRollbackInputTransport |
| RollbackLoop.js | createRollbackLoop |
| SnapshotBinFormat.js | BIN_RECORD_BYTES, PLAYER_BIN_RECORD_BYTES, POS_I32_MAX, SCALE_U16_MAX, clampI16, clampI32Pos, clampU16Scale, PLAYER_TIER_FULL, PLAYER_TIER_REDUCED, REDUCED_POSE_FIELDS, REDUCED_HEIGHT_ABSENT, packReducedPlayerPose, unpackReducedPlayerPose, makeReducedPlayerPose, isReducedPlayerPose, packBinRecord, packPlayerBinRecord, unpackPlayerBinRecord, unpackBinRecord, packQuat, unpackQuat |
| SnapshotPacker.js | snapshotPackCounts, newRecordMemo, packSnapshotBytes |
| TeleportHold.js | TELEPORT_HOLD_MAX_MS, beginTeleportHold, stepTeleportHold |
| TickSystemBase.js | TickSystemBase, probeTimerGranularity |
| WorkerBridgeProxy.js | createWorkerBridgeProxy |
| controlFrame.js | LOCKSTEP_CTRL_PREFIX, ROLLBACK_CTRL_PREFIX, CONSENSUS_CTRL_PREFIX, controlFrameKinds, encodeControlFrame, parseControlFrame, controlFrameHandlers, countReject, countOrder, createFrameClock, advanceFrameClock, dispatchControlFrame |

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
