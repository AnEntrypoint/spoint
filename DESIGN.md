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

Source: `src/terrain/NearFieldLattice.js`. Text moved from the file header and its inline comments, paragraph order kept.

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

## Snapshot packer record memo and share counters

Source: `src/netcode/SnapshotPacker.js`. Text moved from the file comments, paragraph order kept.

Packs the player records once per memo and copies them into every viewer's snapshot bytes.

snapshotHead probes the live packer once per type and memoises the head for the process, so it is only valid while WIRE_STRUCTURES (src/protocol/msgpack.js) is fixed. Under msgpackr's bundleStrings a bundled string is written past the tail, so a record holding one is not position-independent -- strings of one or two bytes are inlined and would splice unchanged, but recordBytes refuses every string rather than track that threshold. A carved range is never rewritten, so a caller may hold a returned buffer until the arena rolls.

Counted work units for the share path: a witness reads these, because a share that is never taken is indistinguishable from a share that costs nothing.

## Input codec

Source: `src/protocol/InputCodec.js`. Text moved from the file comments, paragraph order kept.

The span of one record, validated without building anything. The server decodes every record of every packet and then drops the ones it has already acked, so a packet carrying four redundant records cost four objects and kept one. Measuring the span first is what lets the caller decide whether a record is worth an object at all.

The legacy entry keeps the newest MAX_INPUTS_PER_PACKET records and returns bytes only, so a dropped-records case is announced on the console rather than lost. Callers that branch on it use tryEncodeInputPacket, which returns the case.

A caller that already knows it will drop everything at or below a sequence says so, and those records are walked past instead of decoded: addInput rejects them on the same comparison, so this changes how many objects the decode builds and nothing about which inputs the server keeps.

quantizeInput runs once per input step for as long as the client is connected, so its wire scratch is pooled instead of rebuilt: a fresh buffer and two fresh views per step were three allocations whose entire purpose was to carry bytes across one synchronous call. Nothing outside this module can observe the scratch, and neither writeRecord nor readRecordInto re-enters quantizeInput, so a single module-level buffer is not shared with any second caller.

## Terrain mesh surface

Source: `src/terrain/TerrainMeshSurface.js`. Text moved from the file comments, paragraph order kept.

The ONE authority for "the mesh the renderer drew, at a chart-local (x,z)": the frame's own port, read at the moment it is asked for. Two readers used to resolve it differently -- client/core/ExactPatchFrame.js captured the property by value when its frame was built, while src/terrain/GrassPlacement.js read the same property live, per cell -- so after a late attach or a rebuild (the mirror is rebuilt with the planet, and a quality tier change re-attaches it) the two answered from different meshes: the ground a blade was placed against came from one and the surface the blade was drawn on from the other. Both sides call this now, so a capture cannot survive an attach and there is nothing left to disagree about.

The fixed point a direction's height is solved to, and the test that an answer is the surface's rather than the seed's: the same two numbers client/core/ExactPatchFrame.js uses for the mesh surface, so a vertex read from the lattice and a vertex read from the sampler cannot disagree about what "reached the ground" means.

The shared lattice: the sample buffer the collider builds its field from (src/terrain/LatticeSurface.js). Where it covers a vertex it IS the ground, so the vertex reads it instead of asking the sampler to solve the same point again -- one copy, not two answers.

A direction is not a chart-local (x,z): the point along it sits at radial distance rho, and its chart-local height is the height AT the (x,z) that same rho implies, so   rho * du - base = H(rho * de, rho * dn) is one fixed point in rho -- the same one client/core/ExactPatchFrame.js solves for the mesh surface, so the two agree about what "the ground along this direction" means. Near the chart's anchor it contracts in a step or two, because x and z move by the direction's own east/north components. An answer that has NOT converged is a function of the seed and not of the surface, so it is refused and the sampler answers instead: no vertex silently loses its ground.

The lattice is chart-local and the chart can be re-anchored under it, after which the same (x,z) names different ground. Refuse rather than answer from a chart it no longer describes.

Every read of this mirror used to test EVERY near quad's box and winding: 1218 of them at the shipped focus, ~10 us a read, paid 5 times a placement cell and twice a grass blade. The boxes are axis-aligned in the chart, so a sync-sized uniform grid answers a read with the handful of quads that can actually cover the point. A quad too big to fan out over the grid rides the overflow list instead; both are bbox- and winding-tested exactly as before, so this changes which quads are REJECTED and never which one answers.

A read used to be a function of WHEN the render loop last called sync(), not of the ground it asks about: before the first sync the index is empty and every read answers "no ground", so client/core/ExactPatchFrame.js falls through to the frame's own sampler and every blade, tree and rock the boot prewarm places sits on the fractal instead of on the mesh it is drawn on. Scenery is built before the world is revealed (client/app.js _awaitSceneryBuild runs before _revealWorld, and sync() only runs inside renderPlanet), so that window is the whole initial ring, not one frame. The mirror therefore builds that index the first time it is asked for ground it has none for, around the point it was asked about. It does NOT re-centre on a read that is merely far from the render focus: which quads answer a distant point is the render loop's decision, and moving that decision here changes what every measurement past the focus reads.

One build per version is the bound that keeps this from becoming per-read work: the render loop's own sync() bumps version, so the window before the first frame pays one build.

That bound is on the ATTEMPT, never on the coverage: the version latch below is set only by a sync that actually earned quads. A sync that earned nothing is bounded by the payload it ran on instead -- the same drawn quads cannot cover what they did not cover, so repeating it per read would buy nothing and would cost a sync per read, while a payload that has GROWN since the attempt is a different question and is re-asked. Latched unconditionally, the boot ring's first read -- the one made before the renderer had drawn anything -- claimed the whole version as covered, and every read after it in that version answered "no ground" and fell through to the CPU sampler even once the quads existed.

A chart-local axis box of a rotated quad covers a lot of ground outside it, and every quad it wrongly claims costs a 144-vertex materialisation, so the box only pre-rejects: the actual test is winding-uniform containment in the quad's own corners.

The quad that answers is the finest one covering the point, and among equals the one the linear scan would have reached first: the index must not decide a tie by its own order.

## Grass placement LOD

Source: `src/terrain/GrassPlacementLod.js`. Text moved from the file comments, paragraph order kept.

Law-aware incremental grass placement: coarse first, refined only where the law keeps blades.

src/terrain/GrassPlacement.js places a chunk whole, before anything can ask which of its blades the distance law will actually draw, and the law is per blade: every blade owns a rank q and is drawn only while the player is inside reach(q), so a chunk entering the ring at 88 m is generated at full blade count to keep the fraction the law admits at that distance. That is the waste this module removes.

It is removed by giving each cell a rank-ordered slot list once and materialising a prefix of it. The slots are sorted by the same coin that decides whether a blade exists at all, so the set a distance admits is always a prefix of the set a shorter distance admits, and a chunk that the player approaches is extended in place: every blade already materialised keeps its index and its instance, and refinement costs the delta alone. A chunk the player leaves gives the suffix back, because the law has finished with those blades and the slot is the cost that remains; RELEASE_M is the dead band that keeps the two from fighting over one blade. The blade a slot produces is bit-for-bit the one src/terrain/GrassPlacement.js produces, so the population at any distance is a subset of the old one and never a different one.

How far a blade can sit from the cell centre it was drawn against: the clump radius in the tangent plane plus the horizontal part of the height offset, which tilts with the surface.

How far the player may close before a chunk's population is re-checked. A blade is materialised LEAD_M before it is drawn, so the margin against a blade appearing late is LEAD_M, not zero.

How far past the reach the gate materialised it for a blade has to fall before its slot is given back. The gate works SPREAD_M + SLACK_M ahead of the law, so this is the dead band that keeps walking back over the same ground from re-extending a prefix it has just released.

A compaction is a pass over the whole population, so a release is held until it is one worth taking: a sixteenth of the chunk, or 64 blades for a chunk too small to have a sixteenth.

Where in `blades` each cell's materialised ranks live, in rank order: a release is a suffix of a cell's ranking, and the array is in the order the ranks were materialised, not in cell order.

Positions whose blades have been released and whose rows the holder has not compacted yet.

The nearest a blade of this cell can be to the focus now, less the distance the focus can close before the next re-check: the law holds a blade LEAD_M past its own edge, so a blade drawn anywhere in that band has to have been materialised already.

The other half of the prefix: a blade the law has stopped drawing still costs the slot it was materialised into, and the chunk the player has walked straight through keeps the population it needed going past. Reach is monotone down the ranking, so everything the law has finished with is a suffix of it and giving it back costs the suffix alone. The cut is RELEASE_M past the reach the gate materialised it for, so it cannot fight the gate: closing on the cell again re-extends the same ranking and produces the same blade.

Compaction is one pass over the array and one over the position lists, so a release is held until it is worth a pass rather than paid a blade at a time.

## Tick handler

Source: `src/sdk/TickHandler.js`. Text moved from the file comments, paragraph order kept.

A snapshot tick walks the relevance ring once per recipient it serves, so the work a tick does is recipients * population, and before this neither factor was bounded against the tick budget: a 3000-entity world serving 32 recipients measured ~16 ms of a 16.7 ms tick, and the existing rate control cannot reach past one halving no matter how far over budget the tick runs. SNAP_ENTITY_VISITS_PER_TICK is how many (recipient, entity) pairs one tick is allowed to walk, so a crowded world serves fewer recipients per tick instead of serving one unaffordable tick. It is a function of the world state, never of a wall-clock sample: a cap priced from a timer would make the wire stream depend on how fast the box happens to be.

packSnapshotBytes carves from a rolling arena and ConnectionManager hands the buffer to a transport that may outlive the tick, so the bytes are copied out before they are sent.

What one snapshot tick's player walk cost, in units of players and not of milliseconds: a millisecond is this box's business, and a bound priced from a clock is a positive-feedback loop (smaller fan-out measured a bigger cost per recipient, which shrank the fan-out). These counters are the world-state quantities the walk is a function of, so a witness can pin them.

The per-tick player fan-out. It resolves what the group being served can actually reach BEFORE anything is encoded: the encode pass and the id index are then built over that union, so a tick that serves eight of sixty-four players in one corner of the world does not pack and index the fifty-six nobody in this group can see. Both stages are therefore bounded by the served group's relevance neighbourhoods -- a fact about where the players are -- and no longer by the lobby. The recipient's own neighbourhood is still exactly what it was: nothing here decides who a recipient hears about, only which player records this tick has to build to say it.

Witness switch, and the only one on this surface: with it on, a tick encodes and indexes the whole lobby again instead of the union the served group can reach, which is the shape this row was measured against. It exists so the before/after split is struck inside one process under one load -- this box runs sibling lanes, so two separate runs measure the neighbours as much as the code, and a cap read off such a number is the positive-feedback loop this row forbids.

Grow and shrink in place: rebuilding the array throws away every group's static cache, so a fan-out that moves by one would otherwise re-encode the whole static world on the next tick.

## Collider lattice

Source: `src/shared/colliderLattice.js`. Text moved from the file comments, paragraph order kept.

One derivation of the collider lattice, read by both sides of the terrain: the server's Jolt heightfield and the client's near-band rendered mesh. A near field coarser than the surface the engine already computes and holds is a decimation of work already paid for, so the spacing is not a dial either side may set: it is the finer of the configured lattice and the source the collider follows, from here, once.

The rule mirrors src/terrain/HeightfieldStreamer.js's floorN exactly (same inputs, same expression). HeightfieldStreamer is the authority that BUILDS the field; this module is the one that ANSWERS what spacing that field has, so the renderer can built the same lattice without loading physics. scripts/nearfield-lattice-parity-witness.mjs asserts the two agree.

The bound that keeps a fine field under a megabyte of samples; the streamer clamps its floor to the same number, so the two cannot disagree about what the lattice is.

A lattice coarser than the source it follows is a pure decimation, and that decimation is the whole of the collider's disagreement with the ground. So the answer is the FINER of the two, and a world that follows its source gets the source's spacing instead of the configured one.

N-1 intervals of the source's spacing span the field, which lands the lattice ON the source's own nodes instead of near them: measured on the default world, 1.0039 m nodes leave 0.0080 m mean / 0.1667 m max of pure lattice error where 1.0000 m nodes leave 0.0002 m / 0.0005 m.

The spacing a baked artifact carries, read from the same artifact the server builds its field from. It is the source's own lattice, not the collider's: the collider is the finer of this and the configured resolution, which is what colliderLatticeOf answers.

The spacing the collider actually builds at, resolved from the same baked artifact the server builds its field from. Only the artifact's sample count and extent are read -- no height is recomputed here -- so this cannot introduce a second height function. Where there is no bake, or it cannot be read, the configured lattice stands and the near band degrades to it; a lattice coarser than the collider is a no-op rather than a regression, because the near band never draws coarser than the leaf it replaces.

Bounded: this runs on the boot path and a hung asset fetch must never hold up the planet.

## Grass placement

Source: `src/terrain/GrassPlacement.js`. Text moved from the file comments, paragraph order kept.

The distance-density law: a blade's stable rank q is the coin that decided whether it exists at all, divided by the cell density it was drawn against, so it is uniform on [0,1) and never re-chosen. Dropping the blades with q >= f(d) removes exactly the fraction f(d) of them, and f(d) = (FULL_R / d) ** P is what makes the population grow as R ** (2 - P) and not R ** 2.

Surface reads one blade's own foot costs where the frame carries a drawn mesh: two converge it to 0.0000056 m worst case, a third moves nothing, and one leaves 0.0003824 m. Counted, so the witness can price a blade without re-deriving it.

A blade is not placed at its cell centre: GRASS.CLUMP_R offsets it, and the height it needs is the height AT THE OFFSET. It is read, not extrapolated from the cell's own gradient and curvature -- the extrapolation is a second-order Taylor step over a clump a metre wide, and its remainder is what put blades up to 0.24 m off the surface they were placed on.

The read is taken off the frame's own drawn mesh, at the blade's own horizontal position, rather than by solving along the blade's direction: a solve is a fixed point in the radius and costs 2.35 reads of the SAME mesh (2.53 us a read, 5.94 us a solve -- the micro-benchmark in scripts/grass-seam-card-witness.mjs), while a read converges in two because rise enters the blade's (x,z) only through the up axis' own horizontal component. It is also the more accurate of the two -- 0.0000003 / 0.0000013 / 0.0000056 m against the solve's 0.0000056 / 0.0000107 / 0.0000423 m -- because it never carries a solve tolerance into the blade's foot.

Where the frame carries no drawn mesh the solve is paid exactly as it was, and where neither answers, the Taylor step is. Neither branch removes a blade or coarsens a cell.

The same authority client/core/ExactPatchFrame.js reads: the frame's drawn-mesh port, resolved per cell. A local `typeof` test here is what let the two sides drift apart -- this side read the port live while the placement frame held a capture of it -- so both call one resolver now.

## Placement chart

Source: `src/terrain/PlacementChart.js`. Text moved from the file comments, paragraph order kept.

The project's own surface tolerance (SURFACE_SOLVE_TOLERANCE_M, src/terrain/PlanetFrame.js): the lattice's 1 m bilinear step is an order of magnitude finer than the ground it replaces, so what bounds a solve here is the same number that bounds one there.

The collider's own sample buffer, read along a direction.

src/terrain/LatticeSurface.js holds the one copy the server collides against and the near band draws, so where it covers this direction it IS the ground and placement reads it instead of paying the CPU sampler to solve the same point again: one bilinear step at 0.06-0.10 us where frame.elevationAtDir costs 5.2-6.8 us, and one placement read measured 13.96 us -> 2.17 us over 4000 directions (scripts/shared-lattice-surface-witness.mjs, this lane).

  rho * du - base = sharedLattice(rho * de, rho * dn) + offsetY

is one fixed point in rho -- the same one frame.elevationAtDir solves and the same one the iterate branch below solves, so all three agree about what "the ground along this direction" means. Two seeds are tried, the chart's own anchor height first because it is already known and costs nothing: an answer that has NOT converged is a function of the seed and not of the surface, so it is refused and the caller keeps solving. No placement silently loses its ground.

The field refuses itself once the chart is re-anchored under it, so a stale lattice cannot answer here: covers() goes false and the caller falls through to the sampler for the new chart.

The one copy, before anything re-solves it: every consumer of this function -- vegetation, grass, rocks, and the slope and jet probes they all take -- reads the collider's own samples wherever the bake covers them, and falls through to exactly what it did before where it does not.

## Relocation

Source: `src/sdk/Relocation.js`. Text moved from the file comments, paragraph order kept.

A world authors its spawn point, not the terrain under it: apps/world/tps-game.js declares [-25, 8.39, -45] where the collider probes ground at -0.02 m, so the declared y authors ~8.1 m of air and the player falls on every spawn and every respawn. The y is therefore resolved through the same probe that decides where a held spawn is released, because a corrected literal is a number that is right for today's terrain and wrong after the next terrain change. A probe that finds no ground YET is not a licence to guess: the declared y stands and holdSpawnUntilGrounded places the player when its field lands.

The collider streamer belongs to the physics world (TerrainPhysics sets physics._terrainStreamer); the server boot also mirrors it onto its internal ctx. A relocation is handed the PUBLIC server API, which carries neither, so reading only ctx._terrainStreamer answered "covered" for every field and the hold trusted the surface ray, which released the player the moment the ray first hit a field.

A relocation to a point waits for the same ground, on the same budget, as a spawn: the teleport hold's own 8 s ceiling and its bare 60 m raycast cannot tell "no collider field here yet" from "no ground here at all", so on a world whose collider has to be solved on the CPU -- which is what ?terrainhash=<n> forces, because the shipped bake is rejected for the other hash version -- it released the player into the air long before its field landed and the fall kill took it again on every respawn. One question, one probe, one budget.

## Baked source adapter

Source: `src/terrain/BakedSourceAdapter.js`. Text moved from the file comments, paragraph order kept.

The two adapters for the port src/terrain/TerrainPhysics.js declares. A baked artifact is bytes, a decoder for those bytes and the height code version this tree bakes, and which platform supplies them is the caller's business, never the loader's: TerrainPhysics.js imports neither adapter, so the module that answers what the ground is still parses where neither node:fs nor fetch exists.

Both adapters derive every refusal from bakedFieldError, the one factory the loader throws from, so "absent is a silent fallback, anything else is [baked-heightfield]" has exactly one source.

A bake url is a served path ('/worlds/x.hf', relative to the repo root) or an absolute filesystem path. A rooted url that exists as itself is the filesystem path; anything else is served-relative. Stripping the slash unconditionally read a POSIX absolute path as cwd-relative, so an existing artifact came back ENOENT and was taken for an absent bake.

A browser has no bake sources to rehash, so it cannot stamp or verify one: it reads the artifact's own stamp or warns and falls back, which is the loader's null branch.

## msgpack wire

Source: `src/protocol/msgpack.js`. Text moved from the file comments, paragraph order kept.

Node loads msgpackr synchronously (CJS build via the builtin module loader), so pack/unpack work from the first call after import. The browser has no synchronous loader that avoids bundling msgpackr, so it keeps the async path and the throw until ensurePacked settles.

## AppContext

Source: `src/apps/AppContext.js`. Text moved from the file comments, paragraph order kept.

A computed specifier: the adapter carries node:fs, and both the client bundle and the src/apps/AppContext.js import closure must stay blind to it.

## Heightfield streamer

Source: `src/terrain/HeightfieldStreamer.js`. Text moved from the file comments, paragraph order kept.

One fine field stays under a megabyte of height samples, so a source finer than the configured lattice cannot be followed all the way down into a field that costs more than it is worth.

A guard against a frozen source that turns out not to be cheap, not a dial: 600 ms is above the slowest field the shipped streamer already builds (487 ms of sampling for 16384 live terrain solves), so a fine field over a genuinely cheap source -- measured at 17-31 ms -- is never refused here, while a source that would make it dear still is. It is deliberately not tight, because a tight bound makes the collider's accuracy depend on how fast the machine is.

A field loses the fine lattice unless the frozen source answers essentially all of it. The two cases are far apart, not adjacent: a field snapped onto the source's own grid is either wholly inside the source (1.0) or overhangs it by a whole number of source cells, and one cell of a 256 m field is 1/256 = 0.0039 of it, so the nearest a straddling field reads is 0.9961.

Solved fields kept after the body that solved them is retired, so ground the player has already walked over stays solved. One is a floor-lattice field's sample array: N*N*4 B, 264 KB at N=257, so the whole retain set is a few megabytes next to the 32 MB field wasm budget.

A field whose footprint a frozen source answers can carry a lattice as fine as that source, because a lattice coarser than its source is a pure decimation and that decimation is the whole of the collider's disagreement with the ground (measured on the default world: a 2.02 m lattice over a 1 m source is 0.0383 m mean / 0.5010 m m apart). Where the collider has to re-solve terrain the sample is the cost, so there the configured lattice stands.

extent/(N-1) is the spacing, so N-1 intervals of frozenSpacing span the field: that lands the lattice ON the source's own nodes instead of near them. Measured at extent 256 over the 1 m bake, the difference is the whole residual -- 1.0039 m nodes drift half a cell across the field and leave 0.0080 m mean / 0.1667 m max of pure lattice error, 1.0000 m nodes sitting on the bake's leave 0.0002 m / 0.0005 m. Jolt takes the odd sample count.

NEAR-FIELD FLOOR. Every field this streamer builds covers a player, so every field is a near field, and a near field is never allowed to be coarser than the surface the rest of the engine already reads: grass places a cell every GRASS.CELL metres and reads the ground at every one of them, and this streamer's own fine lattice is the spacing of the source it follows. A collider coarser than either is a decimation of height the terrain system has already produced and is still holding -- the least dense surface in the engine, sitting directly under the player. So the floor is the FINER of the configured lattice and the source's own lattice, from one place, and nothing below may coarsen it. It is derived, not dialled. The old rule let the frozen fraction decide, which made the player's own movement the thing that coarsened the ground under them: a field only ever upgraded to the fine lattice once its footprint was already frozen, so walking out of the bake downgraded the collider from 1 m to 2 m at the exact moment the player arrived.

The one bound on the floor is the fine field's wasm budget, and a floor it cannot honour is a config error, not a quieter collider: the clamp used to be invisible, so the streamer built a coarser near field and never said why.

A fine field also has to SIT on the source's nodes, not merely be spaced like them: a corner snapped to the configured lattice leaves the fine nodes half a cell off the source's across the whole field, which is the same drift as a spacing that does not divide the extent.

Ground this streamer has already solved, kept after the field that solved it is retired. This is what makes the near-field floor affordable while the player travels: a node one field has already solved is, for as long as the chart epoch and the lattice hold, the same height, so a field built over it must not pay to solve it again. It is reuse of a solved value, never a coarser lattice -- every node no seed donates is still solved at the floor.

A patch's corner is in the lattice it was solved in, so a change of lattice orphans every one of them: donating across it would shift a whole field by the difference between the bases.

One sample, one price, and there are two prices: a frozen source answers in ~0.58 us, a live terrain solve in ~35.7 us on this tree, a factor of 60. So the question a field has to answer is WHICH of the two it is made of, and that is a predicate, not a clock. A single mean over the footprint cannot settle it either: the expensive part is a fixed ~1 m strip at the edge of the frozen source, and a sample set coarse enough to be affordable either misses it or over-counts it -- a 16x16 grid calls a 0.8% strip 12% of the field (measured: it priced a 15 ms field at 59 ms). The probe points must also be distinct, because a repeated point hits PlanetFrame's direct-mapped height memo and would price a solve as a hit. Per-sample cost, as a guard against a frozen source that happens to be dear, not as a dial. It also carries the frozen fraction: the predicate is a box test, so that fraction is a property of the field and the source, not of the clock, and answers the same on an idle box and on a box with ten agents running. Minimum of several short batches: a 64-point group of 0.58 us reads is ~37 us of work, which a scheduler preemption anywhere inside it inflates by an order of magnitude, and the minimum over three batches is the batch nothing interrupted.

A field takes the near-field floor, full stop. What that costs is a number the project should be able to read, so it is priced and printed -- but the price no longer decides the lattice. A gate here would make the collider's accuracy a function of how fast the machine is (the same field has been priced at 0.79 us and 1.47 us a sample on a loaded box) or of where the player happens to be standing, and both are the Silent-default class: a measurement quietly turning into a resolution. FINE_SAMPLE_BUDGET_MS therefore names a dear field, it does not refuse one.

Nothing here is frozen, so every node at the floor is a live terrain solve. That is the whole cost of the floor and the reason it used to be traded away; it is printed instead.

A node this streamer has already solved at THIS lattice is donated, not re-solved, wherever the new footprint overlaps an old one. The ruling made every field take the near-field floor, so gridN is now floorN and the old guard (`gridN !== N`, N being the CONFIGURED lattice) answered null for every field from that commit on: each 66049-node field was solved from scratch, including the ~half of it the previous field along the travel path had already solved. Matching a source on its own N and spacing is the same claim, stated where it holds. The lattice a patch was solved in is part of its identity: a patch's corner is in that lattice's coordinates, so donating it across a lattice change would silently shift a whole field.

A source that is not ON this lattice cannot donate: rounding a fraction of a cell would shift the whole donated block and call the shift a reuse.

Price the footprint the field will actually occupy: the fine corner, not the coarse one.

A resculpt means the ground itself was edited, so nothing this streamer solved still holds.

## Lattice surface

Source: `src/terrain/LatticeSurface.js`. Text moved from the file comments, paragraph order kept.

ONE copy of the ground near the player.

The server's terrain collider already builds its field from a baked artifact (apps/world/tps-game.hf: N=257 over 256 m, a 1.0000 m lattice of the chart-local ground). That artifact is a sample buffer, so anything that needs the height of a chart-local (x,z) inside its coverage can READ it instead of solving the terrain again -- and a read is a bilinear step at 0.075 us where the chart-local solve costs 12.1 us and the raw sampler 3.4 us (measured by scripts/shared-lattice-surface-witness.mjs).

This module owns the artifact -> sample-field construction. src/terrain/TerrainPhysics.js is the server's reader and keeps its fail-loud behaviour; this module is the reader everything else uses, including the browser, so the collider, the rendered near band's CPU mirror and the placement sampler are three readers of one buffer rather than three solvers of one function.

Nothing here computes a height: the only height that exists is the one the bake carries.

A lattice is chart-local, so a re-anchored chart rebases it: the same (x,z) then names different ground. The epoch the artifact was baked at rides on the field so a reader can refuse instead of answering from a chart it no longer describes.

The sample field: a regular grid of chart-local ground heights with bilinear lookup. Every reader that wants "how high is the ground at (x,z)" inside the coverage gets this, so no reader can disagree with another about the same point.

epochOf answers the live world frame's chartEpoch. A lattice is chart-local, so the anchor it was baked under is part of what it IS: after a re-anchor the same (x,z) names different ground, and a field that keeps answering there is a stale field that still reports true. The refusal belongs to the field and not to each reader -- a copy of the epoch test in every reader is a staleness guess that any new reader simply omits -- so covers() answers false and heightAtLocal() answers NaN from the moment the anchor moves, and every reader falls back to whatever it did before with no change on its side. Where epochOf is absent the field is unbounded and answers exactly as it always did.

A bake is only the ground if it is the SAME ground. A different terrain key, chart epoch, radius, anchor direction or relief scale is a different surface, and reading it would move every height the readers report -- so it is refused rather than used.

Bounded: this runs on the boot path and a hung asset fetch must never hold up the planet.

The one copy, resolved from the same artifact the server's collider builds from. Returns null -- never a guess -- wherever the artifact is absent, unreadable, stale or for other ground, and the caller keeps whatever it did before; a lattice that refuses is not a regression.

The field is bound to the live frame's anchor here, so the refusal is the anchor's and not a reader's: covers() stops answering true the moment the chart is re-anchored under the field.

## Terrain physics

Source: `src/terrain/TerrainPhysics.js`. Text moved from the file comments, paragraph order kept.

The artifact -> sample-field construction lives in one place so the server's collider, the rendered near band's CPU mirror and the placement sampler are readers of one buffer, not three solvers of one function. Nothing here may compute a height the bake does not carry.

A baked artifact is read through a port, not through a platform: the caller supplies the source that owns readBytes, heightfieldCodec and bakeCodeVersion, and this loader asks it for them. What reads bytes is a fact about the runtime, so a caller that supplies no source is refused instead of being guessed at -- a guessed platform turns an unreadable bake into a silent CPU fallback.

Bound to the live frame's chart epoch, so a re-anchor under this field makes its covers() answer false instead of pointing every reader at the ground of the chart it was baked under.

Placement reads the collider's own buffer through the frame, so trees, rocks and grass sit on the surface the collider simulates instead of paying the CPU sampler to solve it again (src/terrain/PlacementChart.js surfaceAlongDir). Absent a bake there is no lattice and placement keeps solving exactly as it did.

The lattice follows the collider source, not the preset: over a field a frozen source answers in full, a lattice coarser than that source is a pure decimation and is the whole of the collider's disagreement with the ground, while over a field it has to re-solve terrain the sample is the cost and the configured spacing stands.

## Snapshot encoder

Source: `src/netcode/SnapshotEncoder.js`. Text moved from the file comments, paragraph order kept.

Module scratch, not a fresh object per nearby player per recipient: this runs once per recipient per snapshot tick, so the old `{ id, p, d2 }` per neighbour was one allocation per (recipient, nearby player) pair -- 512 of them a tick in a 64-player lobby serving 8. Sorting an index permutation instead keeps the ORDER identical, because Array#sort is stable and the permutation starts in the same order the old array was built in, so ties resolve the same way and the wire bytes do not move.

`needed` is the set of player ids any recipient this tick serves can actually receive. Without it the pass encodes the whole lobby, including players no recipient is within relevance of, so the per-tick player walk was a function of how many people connected rather than of what the group being served can see. Filtering it makes the pass a fact about where the players are.

The per-recipient player LOD walk. It is a static as well as a named export because a frozen ESM namespace cannot be wrapped, so a witness could not otherwise time this stage or count what it walked -- the row that owns this surface has to break the player stages out separately.

Same reason: the tombstone-known-ids walk is one of the per-tick stages a witness has to time.

## Input depth wire

Source: `src/shared/inputDepthWire.js`. Text moved from the file comments, paragraph order kept.

The server-reported input-buffer depth is one byte on the wire in both directions, and hasInputDepth is the one predicate that decides whether a value is one: the encoder (src/netcode/SnapshotEncoder.js inputBufferByte) reports null for anything else and this parse reports NO_INPUT_DEPTH for that same set, so 300, -5, 3.9 and 2^32+7 all mean "not reported" rather than a clamped, truncated or wrapped number.

One parse means one place that decides what a wire byte means, so no consumer re-guesses the sentinel with its own ?? -1 and then re-validates the result.

True only for a reported depth: an integer in 0..255. NO_INPUT_DEPTH, undefined and null are all "not reported", so a caller that narrows on this passes a byte and nothing else.

## Terrain config

Source: `src/shared/terrainConfig.js`. Text moved from the file comments, paragraph order kept.

A carve already in parsed form ({dir, innerM, outerM}) arrives here after a world def crosses the wire, where the parse marker is lost. Accept it only when its shape is valid, so a re-parse is an identity rather than a refusal.

A config that crossed the wire already carries its raw carves in carveInputs; its carves field then holds the parsed {dir, innerM, outerM} form, which must not be hashed as input.

The exact text terrainBakeKey hashes, so a key mismatch can be compared field by field.

## App runtime

Source: `src/apps/AppRuntime.js`. Text moved from the file comments, paragraph order kept.

A non-finite probe is the one input that means "there is no ground here yet", which is the case this hold exists for, so it KEEPS holding: bailing out on it released the player into the air at exactly the target that matters. Only a ground the probe actually knows about can put the player out of the support ray's reach.
