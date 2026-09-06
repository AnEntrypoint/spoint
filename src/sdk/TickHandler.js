import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder, unpackBinRecord, TombstoneLog, updateTombstones, PLAYER_LOD_REDUCED_HZ } from '../netcode/SnapshotEncoder.js'
import { pack } from '../protocol/msgpack.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'
import { applyPlayerCollisions } from '../netcode/CollisionSystem.js'
import { worldToCell, packCellKey, neighborCells } from '../terrain/CubeSphereCells.js'
import { createServerTimeOfDay } from './ServerTimeOfDay.js'
import { createServerWeather } from './ServerWeather.js'
import { enforceMovementEnvelope } from '../netcode/InputGuard.js'
import { checksumBodies } from '../netcode/LockstepChecksum.js'
import { recordSnapshotBytes, recordTickPhase } from './Metrics.js'
// _cellCenterWorld was used by the planetRadius>0 cell-addressing branch below without being imported
// (a ReferenceError on the first curved-space world; the flat-XZ branch never reached it).
import { PRIORITY_ENTITY_BUDGET, PRIORITY_DECAY, BANDWIDTH_BUDGET_BYTES_PER_TICK, trimEntitiesToBudget, estimateEntityBytes, computeRingRelevantIds, getPlayerPriorityIds, clearPlayerPriorityAccumulator, _spatialCache, _cellPackCache, _ringCache, _cellCenterWorld } from './TickHandlerAOI.js'
export { PRIORITY_ENTITY_BUDGET, PRIORITY_DECAY, BANDWIDTH_BUDGET_BYTES_PER_TICK, trimEntitiesToBudget, estimateEntityBytes, getPlayerPriorityIds } from './TickHandlerAOI.js'

const MAX_SENDS_PER_TICK = 25
const INPUT_BACKLOG_DRAIN = 2
const PHYSICS_PLAYER_DIVISOR = 3
const PHYSICS_MAX_ACCUM_DT = 1 / 20
const SNAP_UNRELIABLE = true
const SNAP_RATE_MIN_HZ = 8
const SNAP_RATE_MAX_HZ = 30
const SNAP_RATE_IDLE_HZ = 4
const SNAP_RATE_ADJUST_INTERVAL = 64
const AUTO_SAVE_INTERVAL = 300
const SNAP_PLAYER_LOW = 4
const SNAP_PLAYER_HIGH = 16
const SNAP_RTT_LOW = 50
const SNAP_RTT_HIGH = 200
// Fraction of the per-tick time budget (1000/tickRate ms) that measured snapshot-build cost must exceed
// to count as "expensive" -- mirrors the SNAP_RTT_LOW/HIGH pattern but on the real compute-cost axis.
const SNAP_COST_LOW_FRAC = 0.15
const SNAP_COST_HIGH_FRAC = 0.35
// Below this many nearby players, tiering's sort+classify overhead isn't worth it -- every nearby
// player already gets FULL state via the plain filterEncodedPlayersWithSelf path, same as before.
const PLAYER_LOD_FULL_COUNT_THRESHOLD = 30
// Per-client outgoing-bytes-per-tick cap for the SNAPSHOT payload's entities[] array. This bounds the
// worst case (a player standing in a dense cluster of relevant dynamic entities, all within
// PRIORITY_ENTITY_BUDGET's count cap but each carrying a large `custom` payload) instead of only
// capping entity COUNT -- a count cap alone still lets total bytes balloon per-entity. Real UDP-class
// unreliable transports fragment/drop above ~1200 safe-MTU bytes per datagram; 900 leaves headroom for
// msgpack framing + the players[]/removed[]/seq/tick/serverTime wrapper fields already sharing the
// same packet, and mirrors this file's own SNAP_UNRELIABLE assumption (this is the unreliable-channel
// snapshot path, not a reliable stream where fragmentation is free). Never applied to players[] (always
// sent in full -- they're the highest-priority, typically-small payload) or the static entities[] head
// (already deduped/rare-changing, and dropping map geometry updates would desync collision-relevant
// state); only trims the DYNAMIC tail, farthest-from-viewer first, reusing the same distance-priority
// signal getPlayerPriorityIds already computes.
// Below this entity count, the trim's own sort+repack overhead isn't worth paying -- a handful of
// entities is already comfortably under budget in the overwhelming majority of real snapshots.
const BANDWIDTH_TRIM_MIN_ENTITIES = 6
// Hard cap on trim iterations so a pathological single-entity-over-budget payload (one enormous
// `custom` blob) can't loop forever -- degrade gracefully to "as few entities as it takes, or give up
// after this many drops" rather than an unbounded while loop.
const BANDWIDTH_TRIM_MAX_ITERATIONS = 32

let _lastYaw = NaN, _lastSinHalf = 0, _lastCosHalf = 1

function processPlayerMovement(players, deps, tick, dt, playerIdleCounts, playerAccumDt) {
  const { playerManager, physicsIntegration, lagCompensator, networkState, applyMovement, movement, eventLog, transformRingWriter } = deps
  for (const player of players) {
    const inputs = playerManager.getInputs(player.id)
    const st = player.state
    // backlog <= INPUT_BACKLOG_DRAIN: apply latest immediately (steady state). Larger backlog: drain one/tick so a burst plays out smoothly instead of collapsing to last-only. Always ack the sequence actually applied.
    if (inputs.length > 0) {
      if (inputs.length <= INPUT_BACKLOG_DRAIN) {
        const last = inputs[inputs.length - 1]
        player.lastInput = last.data
        if (last.sequence != null) player.ackSequence = last.sequence
        playerManager.clearInputs(player.id)
      } else {
        const next = inputs.shift()
        player.lastInput = next.data
        if (next.sequence != null) player.ackSequence = next.sequence
      }
    }
    const inp = player.lastInput || null
    if (inp) {
      const yaw = inp.yaw || 0
      if (yaw !== _lastYaw) { const half = yaw / 2; _lastSinHalf = Math.sin(half); _lastCosHalf = Math.cos(half); _lastYaw = yaw }
      st.rotation[0] = 0; st.rotation[1] = _lastSinHalf; st.rotation[2] = 0; st.rotation[3] = _lastCosHalf
      st.crouch = inp.crouch ? 1 : 0; st.lookPitch = inp.pitch || 0; st.lookYaw = yaw
      // Compact viseme/emote expression code (animation-vrm-spring-bone-lod-expression-wire): a plain
      // u8 (see client/core/ExpressionCodes.js) piggybacked on PLAYER_INPUT, same flow as st.crouch from
      // inp.crouch just above -- stored server-side then rebroadcast via networkState.updatePlayer/
      // SnapshotEncoder.encodePlayer below so every OTHER client can apply it to this player's remote avatar.
      st.expr = inp.expr || 0
    }
    applyMovement(st, inp, movement, dt, playerManager.getMovementOverride?.(player.id) || null)
    if (inp) physicsIntegration.setCrouch(player.id, !!inp.crouch)
    const wishedVx = st.velocity[0], wishedVz = st.velocity[2]
    const hasInput = inp && (inp.forward || inp.backward || inp.left || inp.right || inp.jump)
    const isIdle = !hasInput && st.onGround && wishedVx * wishedVx + wishedVz * wishedVz < 1e-4
    const idleCount = playerIdleCounts.get(player.id) || 0
    if (isIdle && idleCount >= 1) { playerIdleCounts.set(player.id, idleCount + 1); playerAccumDt.delete(player.id) }
    else {
      const accumDt = Math.min(PHYSICS_MAX_ACCUM_DT, (playerAccumDt.get(player.id) || 0) + dt)
      // decimate physics only for idle players; an active/airborne player must step every tick or reconciliation reads as jumpy
      if (hasInput || inp?.jump || !st.onGround || (tick + player.id) % PHYSICS_PLAYER_DIVISOR === 0) {
        physicsIntegration.updatePlayerPhysics(player.id, st, accumDt); st.velocity[0] = wishedVx; st.velocity[2] = wishedVz; playerAccumDt.delete(player.id)
      } else { playerAccumDt.set(player.id, accumDt) }
      playerIdleCounts.set(player.id, isIdle ? idleCount + 1 : 0)
    }
    // Movement envelope check (anticheat-server-envelope-checks, docs/anticheat.md): a second,
    // independent layer beneath applyMovement's own structural speed caps -- see InputGuard.js's
    // enforceMovementEnvelope header comment for why this exists as defense-in-depth rather than
    // the primary mechanism. A legitimate player can never reach this branch; every real occurrence
    // is worth an operator-visible eventLog entry (non-blocking, mirrors the statistical-outlier
    // flags below -- flag, never auto-punish, since a false positive here would be a real player
    // losing speed for no visible reason).
    if (enforceMovementEnvelope(st, movement)) {
      eventLog?.record('anticheat_envelope_clamp', { playerId: player.id, position: [...st.position] }, { actor: player.id, reason: 'movement_envelope' })
    }
    lagCompensator.recordPlayerPosition(player.id, st.position, st.rotation, st.velocity, tick)
    // crouch wire slot is bit-packed (bit0=crouch, bit1=swimming) rather than a new protocol field --
    // every consumer of this value (anim locoState threshold, XR capsule-height check, collider shrink)
    // only ever tests it for truthiness, never `=== 1`, so packing a second flag into unused bits is a
    // zero-wire-shape-change addition. See SnapshotEncoder.js's encode/decode for the packed shape.
    const crouchFlags = (st.crouch ? 1 : 0) | (st.swimming ? 2 : 0)
    // Compact equipped-weapon code (animation-weapon-signal-clientside-wiring, see
    // src/shared/WeaponCodes.js): server-authoritative, set via AppRuntime.setPlayerWeapon (never from
    // client input, unlike st.expr/st.crouch above) -- just read through here into the snapshot wire,
    // same optional-numeric-field discipline as st.expr.
    networkState.updatePlayer(player.id, st.position, st.rotation, st.velocity, st.onGround, st.health, player.ackSequence ?? player.inputSequence, crouchFlags, st.lookPitch||0, st.lookYaw||0, st.expr||0, st.weapon||0)
    // SharedArrayBuffer transform-ring hot path (physics-dedicated-worker-transform-offload):
    // best-effort, non-authoritative -- the networkState.updatePlayer call above (feeding the existing
    // postMessage SNAPSHOT channel) remains the single source of truth for every consumer; this write
    // just ALSO publishes the same transform into shared memory for a consumer able to read it with
    // zero postMessage round-trip. transformRingWriter is undefined/null whenever the ring is
    // unavailable (see TransformRing.js's isRingAvailable) -- always guarded, never assumed present.
    if (transformRingWriter) transformRingWriter.write(player.id, st.position, st.rotation, st.velocity)
  }
}


// Player-LOD tiering scratch (see classifyPlayerTiers/filterEncodedPlayersTiered): rebuilt once per
// buildAndSendSnapshots call (module-level to avoid a fresh Map allocation every tick, same pooling
// pattern as TickHandlerAOI.js's _spatialCache/_cellPackCache).
const _playersByIdScratch = new Map()
// Per-tick shared-cell pack cache for the NON-fresh useSharedCell case (see the send stage of
// buildAndSendSnapshots): every player riding a cell's shared delta stream this tick gets a byte-identical
// payload (same players[] from the cell's nearbyPlayerIds, same shared.entities/removed, same tick/
// serverTime), so N-1 msgpackr encodes per cell are skipped. Separate from _cellPackCache (the
// pre-existing empty-entities cache) because a fresh-to-cell player's empty full-set pack and a
// non-fresh player's shared pack can legitimately differ in `removed` under the same cellKey.
const _cellSharedPackCache = new Map()
const _packWrapper = { type: MSG.SNAPSHOT, payload: null }
const _packPayload = { seq: 0, tick: 0, serverTime: 0, players: null, entities: null, removed: undefined, delta: 1, dots: undefined }

function packSnapshot(seq, encoded) {
  _packPayload.seq = seq; _packPayload.tick = encoded.tick; _packPayload.serverTime = encoded.serverTime
  _packPayload.players = encoded.players; _packPayload.entities = encoded.entities
  _packPayload.removed = encoded.removed; _packPayload.delta = encoded.delta
  // dots: DOT-tier player-LOD crowd aggregate (see filterEncodedPlayersTiered) -- undefined on every
  // non-tiered snapshot (the common case), so msgpackr elides the key entirely, same as `removed`.
  _packPayload.dots = encoded.dots
  _packWrapper.payload = _packPayload
  const buf = pack(_packWrapper)
  // server-scale-prometheus-metrics-endpoint-dashboard: this is the single choke point every outgoing
  // snapshot payload passes through (shared-cell fast path, per-viewer delta path, and the legacy
  // relevanceRadius===0 broadcast path all call packSnapshot) -- the real SnapshotEncoder.js output length
  // the PRD row named, counted here rather than re-measured at each of the 3 call sites.
  recordSnapshotBytes(buf.length)
  return buf
}

function buildAndSendSnapshots(players, appRuntime, deps, tick, snapshotSeq, isKeyframe, state, serverNow) {
  const { connections, stageLoader, getRelevanceRadius, networkState, playerEntityMaps } = deps
  const playerSnap = networkState.getSnapshot()
  const playerCount = players.length
  const snapGroups = Math.max(1, Math.ceil(playerCount / 50))
  const curGroup = tick % snapGroups
  const activeStage = stageLoader ? stageLoader.getActiveStage() : null
  const relevanceRadius = activeStage ? activeStage.spatial.relevanceRadius : (getRelevanceRadius ? getRelevanceRadius() : 0)
  // planetRadius > 0 opts a world into curved-space cube-sphere cell addressing (see the cellKey
  // branch below); absent/0 keeps the flat Euclidean XZ grid, the correct default for a single
  // non-reanchoring tangent-plane world (PlanetFrame.js). Stage.js/StageLoader.js thread this
  // through from worldDef.planetRadius.
  const planetRadius = activeStage ? (activeStage.spatial.planetRadius || 0) : 0

  if (relevanceRadius > 0) {
    const curStaticVersion = appRuntime._staticVersion
    // sph-fluid-3d-client-render-verification: _staticVersion alone (spawn/destroy/body-type-change
    // only) is blind to a static-bodyType entity mutating its OWN entity.custom every tick (apps/
    // fluid-source, apps/fluid3d-source) -- getStaticCustomVersionSum() is a cheap O(staticCount)
    // integer-sum comparison (not the full O(staticCount) encode below) that catches that case too,
    // live-reproduced+fixed via a real browser-verb witness (see that function's own comment for detail).
    const curStaticCustomSum = appRuntime.getStaticCustomVersionSum ? appRuntime.getStaticCustomVersionSum() : 0
    let activeStaticEntries = null
    if (isKeyframe || curStaticVersion !== state.lastStaticVersion || curStaticCustomSum !== state.lastStaticCustomSum) {
      const staticSnap = appRuntime.getStaticSnapshot()
      const prevStaticMap = isKeyframe ? new Map() : state.staticEntityMap
      const { staticEntries, changedEntries, staticMap, staticChanged } = SnapshotEncoder.encodeStaticEntities(staticSnap.entities, prevStaticMap)
      state.lastStaticEntries = staticEntries
      if (staticChanged || isKeyframe) { state.staticEntityMap = staticMap; state.staticEntityIds = SnapshotEncoder.buildStaticIds(staticMap); activeStaticEntries = isKeyframe ? staticEntries : changedEntries }
      state.lastStaticVersion = curStaticVersion
      state.lastStaticCustomSum = curStaticCustomSum
    }
    // BUGFIX (found live via this task's own removal-propagation witness): state.knownIds must NOT be
    // reset to null on every _staticVersion bump. _staticVersion increments on EVERY entity spawn/
    // destroy/body-type-change (AppRuntime.js), which is exactly the same tick a real removal needs its
    // tombstone recorded on. updateTombstones(..., prevKnownIds) is a no-op whenever prevKnownIds is
    // null (nothing to diff against yet), so nulling it here silently swallowed the tombstone for
    // whatever entity just disappeared on THIS tick, every single time -- a removal was only ever
    // caught if it happened to coincide with an UNRELATED already-in-flight known-id set from a prior
    // tick. dynCache/prevDynCache still gets a full, correct rebuild here (buildDynamicCache, unrelated
    // to this bug) -- only the known-id diff baseline must survive across a version bump so this tick's
    // real removal is compared against last tick's real known set. Reset ONLY on isKeyframe: a keyframe
    // tick ships every client a full snapshot (not a delta) and also clears playerLastTick, so any
    // client reading the tombstone log after a keyframe starts from clientLastTick=0 and replays full
    // history anyway -- losing one tick's worth of already-covered-by-the-keyframe diff there is safe.
    if (isKeyframe || curStaticVersion !== state.lastDynVersion) { state.prevDynCache = null; state.lastDynVersion = curStaticVersion }
    if (isKeyframe) { state.knownIds = null; state.playerLastTick.clear() }
    const allEncodedPlayers = SnapshotEncoder.encodePlayersOnce(playerSnap.players)
    // Player-LOD tiering (see SnapshotEncoder.js classifyPlayerTiers/filterEncodedPlayersTiered):
    // built once per tick, shared across every viewer below -- a Map<id,player> lookup, not a
    // per-viewer rebuild. reducedTickMod derives the ~PLAYER_LOD_REDUCED_HZ on-wire rate for
    // REDUCED-tier players from this tick's actual (adaptive) snapshot cadence -- a player at the
    // current send rate of e.g. 20Hz gets reducedTickMod=4 so REDUCED updates land at ~5Hz.
    const playersById = _playersByIdScratch; playersById.clear()
    for (const p of playerSnap.players) playersById.set(p.id, p)
    const snapshotHz = deps.getSnapshotHz ? deps.getSnapshotHz() : 20
    const reducedTickMod = Math.max(1, Math.round(snapshotHz / PLAYER_LOD_REDUCED_HZ))
    _spatialCache.clear()
    _cellPackCache.clear()
    _cellSharedPackCache.clear()
    _ringCache.clear()
    let dynCache = null
    let unmanagedIds = null
    for (const player of players) {
      if (player.snapGroup % snapGroups !== curGroup) continue
      if (dynCache === null) {
        const activeIds = appRuntime.getActiveDynamicIds()
        unmanagedIds = appRuntime.getUnmanagedDynamicIds()
        if (state.prevDynCache === null) { state.prevDynCache = SnapshotEncoder.buildDynamicCache(activeIds, appRuntime.getSleepingDynamicIds(), appRuntime.getSuspendedEntityIds(), appRuntime.entities, state.prevDynCache, unmanagedIds) }
        else { SnapshotEncoder.refreshDynamicCache(state.prevDynCache, activeIds, appRuntime.entities, appRuntime.getSleepingDynamicIds(), appRuntime.getSuspendedEntityIds(), unmanagedIds) }
        dynCache = state.prevDynCache
        // Once per tick (not per client): diff this tick's known-id set (dynCache + static) against
        // last tick's to append exactly the entities that dropped out to the global tombstone log --
        // see updateTombstones/TombstoneLog in SnapshotEncoder.js. Each client below then diffs only
        // the tombstone slice newer than its own last-built tick, instead of re-scanning its full
        // prevEntityMap every tick.
        state.knownIds = updateTombstones(state.tombstoneLog, tick, dynCache, state.staticEntityIds, state.knownIds)
      }
      const isNewPlayer = !playerEntityMaps.has(player.id)
      const viewerPos = player.state.position
      // CURVED-SPACE CELL ADDRESSING (planetRadius configured on the active stage): the flat Euclidean
      // XZ cellKey below is exactly right for a single non-reanchoring tangent-plane world (the common
      // case -- see PlanetFrame.js), but breaks down once a world's relevanceRadius-sized interest
      // cells actually span cube-sphere face boundaries (a full-planet server, or a world large enough
      // that the tangent-plane's flatness error matters at cell-boundary scale): two players a few
      // meters apart straddling a face seam would hash to wildly different flat cellKeys despite being
      // spatially adjacent, defeating the whole point of interest-cell payload sharing at that seam.
      // worldToCell/packCellKey resolve the player's world position to its real cube-sphere face+cell
      // (cross-face-correct at edges and cube corners -- see CubeSphereCells.js), and cellViewerPos is
      // re-derived from that SAME face-local cell (not a flat XZ average), so the per-cell distance-tier
      // origin two seam-adjacent clients compute is geometrically consistent across the seam too.
      let cellKey, cellViewerPos, cellFace = -1, cellCx = 0, cellCy = 0, cellsPerFace = 0
      if (planetRadius > 0) {
        const c = worldToCell(viewerPos[0], viewerPos[1], viewerPos[2], planetRadius, relevanceRadius)
        cellFace = c.face; cellCx = c.cx; cellCy = c.cy
        cellsPerFace = Math.ceil((2 * planetRadius) / relevanceRadius)
        cellKey = packCellKey(cellFace, cellCx, cellCy, cellsPerFace)
        // cellViewerPos: reproject the face-local cell CENTER back out along the same ray direction the
        // player sits on, at the player's own radial distance -- gives a real world-space point near the
        // cell center on the curved surface (not a flat-plane average that would cut through the sphere).
        const ATAN_K = Math.PI / 4.0
        const foX = (cellCx + 0.5) * relevanceRadius - planetRadius
        const foY = (cellCy + 0.5) * relevanceRadius - planetRadius
        const wx = planetRadius * Math.tan((foX / planetRadius) * ATAN_K)
        const wy = planetRadius * Math.tan((foY / planetRadius) * ATAN_K)
        const dist = Math.hypot(viewerPos[0], viewerPos[1], viewerPos[2]) || planetRadius
        cellViewerPos = _cellCenterWorld(cellFace, wx, wy, planetRadius, dist)
      } else {
        const cx = Math.floor(viewerPos[0] / relevanceRadius), cz = Math.floor(viewerPos[2] / relevanceRadius)
        cellKey = (cx * 65536 + cz) | 0
        // cellViewerPos: the cell's own center point (not this player's exact position) -- used ONLY as
        // the distance-tier origin (proper-multi-tier-distance-lod-schedule-for-snapshot-updates), so
        // every client sharing a cell computes an IDENTICAL near/mid/far tier verdict per entity. This is
        // what makes per-viewer-encode-sharing-by-interest-cell sound: two clients in the same cell no
        // longer just share relevantIds/nearbyPlayerIds (pre-existing), they now also derive the same
        // tier decision, so their full entities[]/removed[] OUTPUT is identical whenever they also share
        // a delta baseline tick (see cellEncodeCache below) -- real payload sharing, not just id-set reuse.
        cellViewerPos = [(cx + 0.5) * relevanceRadius, viewerPos[1], (cz + 0.5) * relevanceRadius]
      }
      let cached = _spatialCache.get(cellKey)
      if (!cached) {
        cached = { nearbyPlayerIds: appRuntime.nearbyPlayerIds(viewerPos, relevanceRadius), relevantIds: appRuntime.getRelevantDynamicIds(viewerPos, relevanceRadius), cellViewerPos }
        _spatialCache.set(cellKey, cached)
      }
      // Player-LOD tiering: FULL state for the ~PLAYER_LOD_FULL_COUNT nearest players, position+yaw
      // at ~PLAYER_LOD_REDUCED_HZ for the next ring, and everything further aggregated into `dots`
      // (grid-bucketed counts, no per-player wire cost at all) -- see SnapshotEncoder.js. Falls back
      // to the un-tiered filterEncodedPlayersWithSelf ONLY when nearbyPlayerIds is small enough that
      // tiering can't help (avoids the sort+classify cost for the common few-player case).
      // reducedTickMod gates on snapshotSeq (increments by exactly 1 per buildAndSendSnapshots call),
      // NOT the raw physics `tick` counter -- `tick` advances by _snapshotInterval (often >1) between
      // calls here (buildAndSendSnapshots only runs on tick % _snapshotInterval === 0), so `tick %
      // reducedTickMod` would gate at the wrong cadence (reducedTickMod is derived from snapshot Hz,
      // meaningful only against a counter that increments once per snapshot).
      let preEncodedPlayers, playerDots, isTiered = false, isFreshToCell = false
      if (cached.nearbyPlayerIds && cached.nearbyPlayerIds.length > PLAYER_LOD_FULL_COUNT_THRESHOLD) {
        isTiered = true
        const tiered = SnapshotEncoder.filterEncodedPlayersTiered(allEncodedPlayers, playersById, cached.nearbyPlayerIds, player.id, viewerPos, snapshotSeq, reducedTickMod)
        preEncodedPlayers = tiered.players; playerDots = tiered.dots.length ? tiered.dots : undefined
      } else {
        preEncodedPlayers = SnapshotEncoder.filterEncodedPlayersWithSelf(allEncodedPlayers, cached.nearbyPlayerIds, player.id)
      }
      const scratch = deps.getPlayerScratch(player.id)
      const prevPlayerMap = isNewPlayer ? new Map() : playerEntityMaps.get(player.id)
      // Ring-of-cells subscription: union relevantIds/nearbyPlayerIds across the cell + its Moore
      // neighborhood (see computeRingRelevantIds) so an entity just across a neighbor cell's border is
      // never missed for a player standing near the shared edge -- a single-cell query alone only
      // guarantees coverage of relevanceRadius from the CELL CENTER, not from every point inside the
      // cell out to its own edges.
      const ring = computeRingRelevantIds(cellKey, cellFace, cellCx, cellCy, cellsPerFace, planetRadius, relevanceRadius, appRuntime)
      // Cube-sphere cell-grid AOI, shared per-cell encoded payload: when the ring's relevant-id count
      // fits inside the per-tick entity budget, EVERY player homed to this cell (not just a newly
      // joining one) shares ONE encode of entities[]/removed[] this tick, built once against a per-CELL
      // delta baseline (state.cellEntityMaps) rather than each player's own prevEntityMap, and diffed
      // for removals via a per-cell tombstone cursor (state.cellLastTick) instead of each player's own
      // last-tick. This is the real hot-path win: encode cost amortizes over every player sharing a
      // cell, not just id-set/nearbyPlayerIds reuse (which was the pre-existing partial win) and not
      // just brand-new joiners (the prior narrower special case). A cell whose ring exceeds the budget
      // (a dense/crowded region) falls back to the existing per-player priority-decayed path below --
      // sharing a budget-exceeding set would defeat the whole point of the budget (bounding worst-case
      // per-client payload size), so that fallback is a deliberate, honest limit, not an oversight.
      const useSharedCell = ring.relevantIds.size <= PRIORITY_ENTITY_BUDGET
      let encoded, entityMap
      if (useSharedCell) {
        let cellMap = state.cellEntityMaps.get(cellKey)
        if (!cellMap) { cellMap = new Map(); state.cellEntityMaps.set(cellKey, cellMap) }
        let shared = cached.sharedEncode
        if (!shared || shared.tick !== tick) {
          let relevantIds = ring.relevantIds
          if (unmanagedIds && unmanagedIds.length) {
            const relSet = relevantIds === ring.relevantIds ? new Set(relevantIds) : relevantIds
            for (const id of unmanagedIds) relSet.add(id)
            relevantIds = relSet
          }
          const cellLastTick = state.cellLastTick.get(cellKey) || 0
          // Static entries for the ONGOING per-cell delta stream are always the tick's true incremental
          // changed set (activeStaticEntries) -- never state.lastStaticEntries (a full re-send), and
          // never conditioned on which player happens to trigger the rebuild this tick (that would make
          // the shared payload's shape depend on iteration order, breaking the "one encode per cell"
          // invariant this whole path exists for). A freshly-joined player's need for the FULL static
          // set is handled separately below, from state.lastStaticEntries directly.
          const r = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverNow, dynCache, relevantIds, cellMap, [], activeStaticEntries, state.staticEntityMap, state.staticEntityIds, snapshotSeq, cached.cellViewerPos, null, state.tombstoneLog, cellLastTick, snapshotHz)
          shared = { tick, entities: r.encoded.entities, removed: r.encoded.removed, entityMap: r.entityMap }
          // Tag the cell baseline map: it is handed to every non-fresh player BY REFERENCE below (see
          // entityMap), and the per-player path's spare-map double buffer must never adopt+clear it.
          r.entityMap._cellShared = true
          cached.sharedEncode = shared
          state.cellEntityMaps.set(cellKey, r.entityMap)
          state.cellLastTick.set(cellKey, tick)
        }
        // A player who was NOT already tracking this cell's baseline (just joined, or just crossed into
        // this cell from another) cannot safely receive a DELTA against the cell's ongoing baseline --
        // they never saw the earlier ticks that baseline's deltas assume as their starting state. Give
        // such a player the cell's FULL current entity set instead (cached.sharedFull, refreshed
        // alongside the shared delta every time it's rebuilt, itself also shared across every player
        // freshly joining the SAME cell this same tick) exactly once, then they ride the shared delta
        // stream from the next tick onward -- a real keyframe/delta-reset per (player,cell) transition,
        // the same correctness contract encodeDeltaFromCache's own prevEntityMap gives per-player today.
        isFreshToCell = state.playerCell.get(player.id) !== cellKey
        // Non-fresh players share the cell baseline Map by reference (was a fresh clone per player per
        // tick): the cell map is never mutated after it is built (encodeDeltaFromCache writes a NEW map
        // each rebuild, scratch=null), and the only consumer that could ever clear it -- the per-player
        // path's spareMap double buffer -- refuses a _cellShared map (see below). A fresh-to-cell player
        // still gets a private clone: its full-set resync is a per-(player,cell) event, not the stream.
        entityMap = isFreshToCell ? new Map(shared.entityMap) : shared.entityMap
        if (isFreshToCell) {
          let full = cached.sharedFull
          if (!full || full.tick !== tick) {
            const dynEntities = Array.from(shared.entityMap.values()).map(v => v[3]).filter(Boolean)
            const staticEnts = state.lastStaticEntries || []
            full = { tick, entities: staticEnts.map(se => se.enc).concat(dynEntities) }
            cached.sharedFull = full
          }
          encoded = { tick: playerSnap.tick || 0, serverTime: serverNow, players: preEncodedPlayers || [], entities: full.entities, removed: undefined, delta: 1 }
        } else {
          encoded = { tick: playerSnap.tick || 0, serverTime: serverNow, players: preEncodedPlayers || [], entities: shared.entities, removed: shared.removed, delta: 1 }
        }
        state.playerCell.set(player.id, cellKey)
      } else {
        let relevantIds = getPlayerPriorityIds(player.id, ring.relevantIds, dynCache, viewerPos, tick)
        // Unmanaged (physics-body-less) dynamic entities are ALWAYS forced relevant, independent of the
        // spatial octree's distance verdict -- Stage.syncPositions() keeps the octree in sync every tick
        // now, but this is a deliberate belt-and-suspenders guard: such an entity's octree entry could
        // still read stale for one tick around a relevance-radius boundary crossing (index update
        // happens before the relevance query in the same tick, but a future ordering change or a
        // skipped sync tick would silently reintroduce the freeze this bug was about). Cheap -- there
        // are typically very few physics-body-less dynamic entities in a world.
        if (unmanagedIds && unmanagedIds.length) {
          const relSet = relevantIds instanceof Set ? relevantIds : new Set(relevantIds)
          for (const id of unmanagedIds) relSet.add(id)
          relevantIds = relSet
        }
        const clientLastTick = isNewPlayer ? 0 : (state.playerLastTick.get(player.id) || 0)
        const staticEntriesForCall = isNewPlayer ? state.lastStaticEntries : activeStaticEntries
        const r = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverNow, dynCache, relevantIds, prevPlayerMap, preEncodedPlayers, staticEntriesForCall, state.staticEntityMap, state.staticEntityIds, snapshotSeq, viewerPos, scratch, state.tombstoneLog, clientLastTick, snapshotHz)
        encoded = r.encoded; entityMap = r.entityMap
        // Double-buffer swap -- but a prevPlayerMap that is a shared cell baseline (this player just
        // left the useSharedCell path) must NOT become the spare: the next call would clear() it while
        // it is still that cell's live delta baseline for every other player. Allocate a private spare
        // once on that transition instead (rare: a cell-path change, not a per-tick event).
        scratch.spareMap = prevPlayerMap._cellShared ? new Map() : prevPlayerMap
        state.playerCell.delete(player.id)
        // Per-client outgoing-bytes-per-tick budget: this is the one path with both a real per-viewer
        // entities[] array (not shared across players like the useSharedCell branch above, whose payload
        // must stay byte-identical for every viewer of the cell) and a known viewerPos to prioritize by
        // distance -- see trimEntitiesToBudget. Static entries always sit at the front of encoded.entities
        // (encodeDeltaFromCache pushes them before any dynamic entry) and are never trimmed.
        const staticCountForTrim = staticEntriesForCall ? staticEntriesForCall.length : 0
        if (encoded.entities.length - staticCountForTrim >= BANDWIDTH_TRIM_MIN_ENTITIES) {
          const trim = trimEntitiesToBudget(encoded.entities, staticCountForTrim, viewerPos, dynCache)
          if (trim.trimmedCount > 0) encoded.entities = trim.entities
        }
      }
      // playerDots: DOT-tier crowd aggregate for this viewer (see filterEncodedPlayersTiered above).
      // Attached post-hoc rather than threaded through encodeDeltaFromCache's already-long positional
      // signature -- it is purely a function of (nearbyPlayerIds, viewerPos), independent of the
      // entity-delta machinery encodeDeltaFromCache owns. Bypasses the shared _cellPackCache below:
      // that cache assumes byte-identical packed output across every player sharing a cellKey this
      // tick, which playerDots (per-viewer, derived from each player's own distance to every nearby
      // player) breaks -- caching a dots-bearing pack under one cellKey would leak one viewer's dot
      // aggregate onto every other player sharing that cell's empty-entities fast path.
      if (playerDots) encoded.dots = playerDots
      state.playerLastTick.set(player.id, tick)
      playerEntityMaps.set(player.id, entityMap)
      // Shared-pack invariant: a cell-keyed pack is byte-identical for every player only if (a) players[]
      // came from the un-tiered filterEncodedPlayersWithSelf (tiering orders/aggregates by each viewer's
      // own position) and (b) this player's own id is in the cell's nearbyPlayerIds -- otherwise
      // filterEncodedPlayersWithSelf appends self at the END, a per-viewer shape. (b) can fail for a
      // player homed to a cell whose nearbyPlayerIds were queried around ANOTHER player's position (cell
      // edge = relevanceRadius, so two players in one cell can sit up to sqrt(2)*R apart); such a player
      // falls through to its own per-client pack rather than receiving a payload missing its own record.
      let shareable = false
      if (!isTiered && !playerDots) {
        let nearSet = cached.nearbySet
        if (!nearSet) { nearSet = new Set(cached.nearbyPlayerIds); cached.nearbySet = nearSet }
        shareable = nearSet.has(player.id)
      }
      let packedData
      if (shareable && encoded.entities.length === 0 && !encoded.removed) {
        packedData = _cellPackCache.get(cellKey)
        if (!packedData) { packedData = packSnapshot(snapshotSeq, encoded); _cellPackCache.set(cellKey, packedData) }
      } else if (shareable && useSharedCell && !isFreshToCell) {
        // Non-fresh shared-cell stream: entities/removed are the cell's shared encode and players[] is the
        // cell's nearby set -> one msgpackr encode per cell per tick, reused by every other rider.
        packedData = _cellSharedPackCache.get(cellKey)
        if (!packedData) { packedData = packSnapshot(snapshotSeq, encoded); _cellSharedPackCache.set(cellKey, packedData) }
      } else {
        packedData = packSnapshot(snapshotSeq, encoded)
      }
      connections.sendPacked(player.id, packedData, SNAP_UNRELIABLE, MSG.SNAPSHOT)
    }
    // Prune the tombstone log to the oldest tick any currently-connected client OR any live per-cell
    // baseline might still need -- bounds its memory to "removals since the slowest reader's last
    // snapshot" rather than growing forever. Cheap: runs once per tick, only when dynCache actually ran
    // this tick (dynCache !== null guards groups where no player in this tick's snapGroup triggered a
    // dynCache (re)build). Per-cell baselines are also pruned here: a cell nobody sits in anymore (no
    // player's playerCell entry references it) is dropped so cellEntityMaps/cellLastTick don't grow
    // unbounded as players roam across a large or planet-scale world.
    if (dynCache !== null && (state.playerLastTick.size > 0 || state.cellLastTick.size > 0)) {
      let minTick = tick
      for (const t of state.playerLastTick.values()) { if (t < minTick) minTick = t }
      for (const t of state.cellLastTick.values()) { if (t < minTick) minTick = t }
      state.tombstoneLog.pruneBefore(minTick)
      if (state.cellLastTick.size > 0) {
        const liveCells = new Set(state.playerCell.values())
        for (const key of state.cellLastTick.keys()) {
          if (!liveCells.has(key)) { state.cellLastTick.delete(key); state.cellEntityMaps.delete(key) }
        }
      }
      // Spatial-index per-cell memories (player-index hysteresis pairs, stage-index starvation clocks) are
      // keyed by the same cellKeys _spatialCache holds this tick (home cells + ring neighbors). Amortized
      // (& 63, same cadence as AppRuntimeTick's collision-grid prune), and output-identical by
      // construction: pruneIdleKeys only drops a key whose memory is already empty -- see Octree.js.
      if ((snapshotSeq & 63) === 0) {
        appRuntime._playerIndex?.pruneIdleKeys?.(_spatialCache)
        appRuntime._stageLoader?._activeStage?.spatial?.pruneIdleKeys?.(_spatialCache)
      }
    }
  } else {
    // No per-viewer relevanceRadius/AOI configured for this world -- every connected player is sent the
    // SAME encoded payload (one shared pack, `data` below), by design, with no per-viewer viewerPos to
    // prioritize a distance-based trim against. trimEntitiesToBudget is deliberately NOT applied on this
    // path for the same reason it's skipped on the useSharedCell per-cell path above: a byte-budget trim
    // is only meaningful (and safe -- never silently desyncing one viewer's state from another's) when it
    // can be computed per-viewer; this broadcast path's entire point is that every viewer gets an
    // identical payload. A relevanceRadius-configured world is the one this budgeter targets.
    const entitySnap = appRuntime.getSnapshot()
    const combined = { tick: playerSnap.tick, players: playerSnap.players, entities: entitySnap.entities, serverTime: serverNow }
    const prevMap = (isKeyframe || state.broadcastEntityMap.size === 0) ? new Map() : state.broadcastEntityMap
    const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, prevMap)
    state.broadcastEntityMap = entityMap
    const data = packSnapshot(snapshotSeq, encoded)
    for (const player of players) {
      if (!isKeyframe && player.snapGroup % snapGroups !== curGroup) continue
      connections.sendPacked(player.id, data, SNAP_UNRELIABLE, MSG.SNAPSHOT)
    }
  }
}

export function createTickHandler(deps) {
  // 60Hz default (was 128) -- mirrors src/sdk/server.js's config.tickRate||60; every real caller passes
  // tickRate explicitly, this is only a defensive fallback.
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: m = {}, stageLoader, getRelevanceRadius, _movement, tickRate = 60, getWorldTimeOfDayConfig, getWorldWeatherConfig } = deps
  // Server-authoritative day-cycle clock (server-clock-synced-time-of-day-network-sync). Passed the LIVE
  // getWorldTimeOfDayConfig ACCESSOR (not a pre-resolved value) -- ServerTimeOfDay.js re-reads it lazily on
  // every tick, since ctx.currentWorldDef is NOT yet populated at TickHandler-construction time (see
  // ServerTimeOfDay.js's header comment for the real bug this fixes: a construction-time-only read always
  // saw worldDef===undefined and permanently disabled itself, live-witnessed with a real 2-client WS
  // harness against tps-game before this fix). Absent getWorldTimeOfDayConfig, or a config with
  // serverAuthoritative!==true, both leave this fully inert -- a caller that never passes it (or a world
  // without terrain.timeOfDay) sees zero behavior change.
  const serverTimeOfDay = createServerTimeOfDay(getWorldTimeOfDayConfig)
  // Server-authoritative weather state (weather-server-driven-state-and-multiplayer-sync). Same lazy-
  // accessor discipline as serverTimeOfDay immediately above (getWorldWeatherConfig re-read on every
  // isEnabled()/getSyncPayload() call, not resolved once at construction) for the identical reason: this
  // module is constructed before ctx.currentWorldDef is populated. Unlike serverTimeOfDay, ServerWeather
  // has no per-tick advance step -- it is a discrete state broadcast on CHANGE (see shouldBroadcast's
  // dirty flag), not a continuously-advancing clock re-broadcast on a fixed cadence.
  const serverWeather = createServerWeather(getWorldWeatherConfig)
  const KEYFRAME_INTERVAL = tickRate * 10
  let _snapshotInterval = 1
  let _snapRateAdjustTick = 0
  let _lastSnapRate = tickRate
  // opt-in: process.memoryUsage() + template string per keyframe log is real cost, gated off by default; SPOINT_TICK_PROFILE=1 or deps.enableProfiling enables
  const _PROFILE = deps.enableProfiling || (typeof process !== 'undefined' && process.env?.SPOINT_TICK_PROFILE === '1')
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  const mvDeps = { playerManager, physicsIntegration, lagCompensator, networkState, applyMovement, movement, eventLog: deps.eventLog, transformRingWriter: deps.transformRingWriter || null }
  // playerScratch: per-player pooled { entities:[], removed:[], spareMap:Map } reused every tick instead
  // of allocating fresh entities/removed arrays and a fresh nextMap per player per tick (the configured server tick rate x N
  // clients -- the dominant GC-pressure source this pools away). spareMap is the OTHER half of a
  // double-buffer with playerEntityMaps.get(id): each tick, encodeDeltaFromCache writes into spareMap
  // while reading the current playerEntityMaps entry as prevEntityMap, then the two are swapped -- so a
  // map is never cleared/reused while it is still this call's prevEntityMap (that would erase the very
  // data the delta is being computed against), and it only becomes the write target again once it has
  // aged out one full tick as the (now-stale, already-consumed) prevEntityMap.
  const playerScratch = new Map()
  function getPlayerScratch(id) {
    let s = playerScratch.get(id)
    if (!s) { s = { entities: [], removed: [], spareMap: new Map() }; playerScratch.set(id, s) }
    return s
  }
  // getSnapshotHz: a live accessor (not a captured value) so player-LOD REDUCED-tier throttling
  // (see buildAndSendSnapshots) always derives its ~5Hz on-wire cadence from the CURRENT adaptive
  // snapshot rate (_lastSnapRate, updated by _computeSnapshotInterval below as player count/RTT/cost
  // change), not a stale boot-time tickRate.
  const snapDeps = { connections, stageLoader, getRelevanceRadius, networkState, playerEntityMaps: new Map(), playerScratch, getPlayerScratch, getSnapshotHz: () => _lastSnapRate }
  // cellEntityMaps/cellLastTick: the per-CELL delta baseline + tombstone cursor that makes shared
  // per-cell encoding real (see the useSharedCell branch in buildAndSendSnapshots) -- one Map/tick
  // number per unique AOI cell any player currently occupies, NOT per player. playerCell tracks which
  // cell each player's own last-received snapshot was baselined against, so a player who just joined a
  // cell (or crossed into it from another) is detected and given a one-time full resync instead of an
  // unsafe delta against baseline ticks they never saw.
  const snapState = { broadcastEntityMap: new Map(), staticEntityMap: new Map(), staticEntityIds: null, lastStaticEntries: null, lastStaticVersion: -1, lastStaticCustomSum: -1, lastDynVersion: -1, prevDynCache: null, tombstoneLog: new TombstoneLog(), knownIds: null, playerLastTick: new Map(), cellEntityMaps: new Map(), cellLastTick: new Map(), playerCell: new Map() }
  const playerIdleCounts = new Map(), playerAccumDt = new Map()
  const grid = new Map(), gridCells = new Map()
  let snapshotSeq = 0, profileLog = 0, profileSum = 0, profileSumSnap = 0, profileSumPhys = 0, profileSumMv = 0, profileCount = 0
  let _lastBudgetWarnMs = 0

  let _lastBandHz = tickRate
  let _rateChangeTick = 0
  // Real measured per-tick snapshot-build cost (EMA), fed from buildAndSendSnapshots' own wall time on
  // every tick a snapshot actually sends -- see _snapCostEmaMs update in onTick below. Player COUNT alone
  // is a proxy for "how expensive is this tick's snapshot work" that silently diverges from the real
  // driver: buildAndSendSnapshots' cost scales with relevance-filtered nearby-player/entity PAIRS within
  // each viewer's radius, not raw connected-player count -- a small dense crowd (everyone clustered,
  // mutually relevant) can cost far more per tick than a larger but spread-out population where most
  // players fall outside each other's relevanceRadius and get filtered out cheaply. SNAP_COST_HIGH_FRAC/
  // SNAP_COST_LOW_FRAC mirror the existing avgRtt high/low thresholds' shape (a real-measurement throttle
  // layered on top of the player-count band, not a replacement -- the band still provides a safe
  // cold-start default before any snapshot has been measured).
  let _snapCostEmaMs = 0
  const SNAP_COST_EMA_ALPHA = 0.2

  function _computeSnapshotInterval(players, tick) {
    const pc = players.length
    let bandHz = tickRate
    if (pc === 0) {
      bandHz = SNAP_RATE_IDLE_HZ
    } else if (pc <= SNAP_PLAYER_LOW) {
      bandHz = SNAP_RATE_MAX_HZ
    } else if (pc >= SNAP_PLAYER_HIGH) {
      bandHz = SNAP_RATE_MIN_HZ
    } else {
      const t = (pc - SNAP_PLAYER_LOW) / (SNAP_PLAYER_HIGH - SNAP_PLAYER_LOW)
      bandHz = Math.round(SNAP_RATE_MAX_HZ - t * (SNAP_RATE_MAX_HZ - SNAP_RATE_MIN_HZ))
    }
    const rateDiff = bandHz - _lastBandHz
    const tickSinceChange = tick - _rateChangeTick
    // Hysteresis applies ONLY to the player-count BAND (damps flapping as players join/leave near a band
    // edge) -- it must never gate whether RTT/real-cost gets RE-EVALUATED, or a population that settles
    // into a stable band (the common case) permanently freezes the RTT/cost throttles at whatever they
    // read the one time the band last changed. (Found live: a population stable at pc=3 for its whole
    // session never re-read avgRtt after the initial band settle, even after RTT spiked to 300ms well
    // past SNAP_RTT_HIGH=200 -- the rate stayed pinned at the pre-spike value forever.) So bandHz is
    // damped here, but avgRtt/_snapCostEmaMs are read and applied fresh on EVERY call.
    const targetHzBase = (Math.abs(rateDiff) <= 2 || tickSinceChange < tickRate * 2) ? _lastBandHz : bandHz
    if (targetHzBase !== _lastBandHz) { _lastBandHz = targetHzBase; _rateChangeTick = tick }
    let targetHz = targetHzBase
    let avgRtt = 0
    try {
      const conns = connections?.clients
      if (conns && conns.size > 0) {
        let rttSum = 0, rttCount = 0
        for (const client of conns.values()) {
          if (client.rtt != null) { rttSum += client.rtt; rttCount++ }
        }
        if (rttCount > 0) avgRtt = rttSum / rttCount
      }
    } catch (_) {}
    if (avgRtt > SNAP_RTT_HIGH) targetHz = Math.max(SNAP_RATE_MIN_HZ, Math.round(targetHz * 0.5))
    else if (avgRtt > SNAP_RTT_LOW) targetHz = Math.round(targetHz * 0.75)
    if (avgRtt < SNAP_RTT_LOW && targetHz < SNAP_RATE_MAX_HZ) targetHz = Math.min(SNAP_RATE_MAX_HZ, targetHz + 2)
    // Real-cost throttle: a dense/clustered crowd measured expensive to snapshot (regardless of what the
    // player-count band alone would pick) pulls the rate down further, same direction+shape as the RTT
    // adjustment above but driven by actual measured compute, not an assumed-uniform per-player cost.
    const tickBudgetMs = 1000 / tickRate
    if (_snapCostEmaMs > tickBudgetMs * SNAP_COST_HIGH_FRAC) targetHz = Math.max(SNAP_RATE_MIN_HZ, Math.round(targetHz * 0.5))
    else if (_snapCostEmaMs > tickBudgetMs * SNAP_COST_LOW_FRAC) targetHz = Math.round(targetHz * 0.75)
    return Math.max(1, Math.round(tickRate / Math.max(SNAP_RATE_IDLE_HZ, Math.min(SNAP_RATE_MAX_HZ, targetHz))))
  }

  // simulateTick: the PURE deterministic-simulation subset of a tick -- movement -> player collisions ->
  // physics.step -> appRuntime.tick -- with ZERO network I/O side effects (no snapshot build, no
  // connections.broadcast/emit, no networkState.setTick/rate-adjust bookkeeping). This is exactly the
  // slice rollback-tickhandler-resimulate-loop's rewind+replay-forward orchestration (RollbackLoop.js)
  // needs to call once per resimulated tick: onTick's snapshot/broadcast half is a real one-time-only
  // wire side effect (it would double-send stale snapshots for every already-broadcast historical tick
  // if replayed) and must never re-run, but the physics/app simulation half is exactly what a correct
  // GGPO-style resimulate pass re-executes with corrected input. Returns nothing; mutates players/physics/
  // appRuntime state in place, identically to what onTick's own inline sequence below does -- onTick
  // calls this function rather than duplicating the sequence, so the two can never drift apart.
  function simulateTick(tick, dt, players) {
    processPlayerMovement(players, mvDeps, tick, dt, playerIdleCounts, playerAccumDt)
    const cellSz = physicsIntegration.config.capsuleRadius * 8, minDist = physicsIntegration.config.capsuleRadius * 2
    applyPlayerCollisions(players, grid, gridCells, cellSz, minDist * minDist, minDist, dt, physicsIntegration)
    // must run before physics.step: drains VegPhysics/RockPhysics streamer-queued collider add/remove into Jolt's broadphase
    if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()
    physics.step(dt)
    appRuntime.tick(tick, dt)
  }

  function onTick(tick, dt) {
    const t0 = performance.now()
    const serverNow = Date.now()
    networkState.setTick(tick, serverNow)
    const players = playerManager.getConnectedPlayers()

    if (tick - _snapRateAdjustTick >= SNAP_RATE_ADJUST_INTERVAL) {
      _snapRateAdjustTick = tick
      _snapshotInterval = _computeSnapshotInterval(players, tick)
      if (players.length > 0 && connections) {
        _lastSnapRate = Math.round(tickRate / _snapshotInterval)
        connections.emit('snapshot-rate', { rate: _lastSnapRate, tick, interval: _snapshotInterval })
      }
    }

    const t1pre = performance.now()
    simulateTick(tick, dt, players)
    const t4 = performance.now()
    // sub-phase split points (mv/col/phys) are no longer individually measurable now that simulateTick is
    // one opaque call shared with the rollback resimulate path (simulateTick must stay a single indivisible
    // unit so the resimulate loop replays EXACTLY what onTick would have run, never a hand-picked subset of
    // its internal phases) -- t1/t2 collapse to t1pre and t3 to t4 so the profiler's mv/col/phys buckets
    // report the combined simulateTick total under `phys` rather than silently reporting a fabricated
    // (always-zero) split; sync/respawn/etc's OWN sub-timers (appRuntime._lastSyncMs etc, logged separately
    // below) still carry the fine-grained post-simulateTick detail.
    const t1 = t1pre, t2 = t1pre, t3 = t4
    if (players.length > 0 && tick % _snapshotInterval === 0) {
      snapshotSeq++
      buildAndSendSnapshots(players, appRuntime, snapDeps, tick, snapshotSeq, snapshotSeq % KEYFRAME_INTERVAL === 0, snapState, serverNow)
      // EMA of the REAL measured snapshot-build wall time, isolated to just this call (not the cleanup
      // loop/auto-save below) -- feeds _computeSnapshotInterval's real-cost throttle so a dense/clustered
      // crowd that's expensive to snapshot self-corrects even when raw connected-player count is low.
      const _snapCostMs = performance.now() - t4
      _snapCostEmaMs = _snapCostEmaMs === 0 ? _snapCostMs : (_snapCostEmaMs * (1 - SNAP_COST_EMA_ALPHA) + _snapCostMs * SNAP_COST_EMA_ALPHA)
    }
    // ~1Hz broadcast of every connected client's server-measured RTT (the same EWMA client.rtt already
    // computed per-HEARTBEAT in ServerHandlers.js, reused here rather than re-measuring). This is the data
    // a P2P/wireweave room's host-migration election (client/HostMigration.js) needs: in a star topology
    // (only the host has an RTC data channel to each joiner) there is no peer-to-peer ping mesh, so every
    // joiner learning the SAME server-observed RTT numbers is the only way they can all independently agree
    // on the same "lowest-ping remaining peer" winner without a vote round-trip. Harmless on the plain WS
    // server path too (clients that never look at PEER_RTT_TABLE simply ignore it) -- kept unconditional
    // rather than gated on a P2P flag so a WS-hosted room could reuse the same election code path later.
    if (players.length > 0 && tick % tickRate === 0) {
      const rttTable = {}, pubkeys = {}
      for (const p of players) {
        const c = connections.getClient(p.id)
        if (!c) continue
        if (c.rtt != null) rttTable[p.id] = c.rtt
        // Only populated for wireweave P2P peers (see ConnectionManager.addClient) -- lets every joiner
        // resolve a server playerId from this table back to the wireweave pubkey it needs to reconnect a
        // data channel to during host migration (client/HostMigration.js). Absent/empty on the plain WS path.
        if (c.peerPubkey) pubkeys[p.id] = c.peerPubkey
      }
      connections.broadcast(MSG.PEER_RTT_TABLE, { rtt: rttTable, pubkeys })
    }
    // Server-authoritative day-cycle clock (server-clock-synced-time-of-day-network-sync): advance every
    // tick (real elapsed dt, matching TimeOfDay.js's own local update() formula) so the fraction stays
    // correct regardless of snapshot/broadcast cadence, but only BROADCAST the coarse correction on
    // serverTimeOfDay's own ~5s real-time cadence (see ServerTimeOfDay.js's shouldBroadcast). Both calls
    // are no-ops when the world never opted in (worldDef.terrain.timeOfDay.serverAuthoritative!==true).
    serverTimeOfDay.tick(dt)
    if (players.length > 0 && serverTimeOfDay.shouldBroadcast()) {
      connections.broadcast(MSG.TIME_OF_DAY_SYNC, serverTimeOfDay.getSyncPayload())
    }
    // Server-authoritative weather state (weather-server-driven-state-and-multiplayer-sync): no per-tick
    // advance (unlike serverTimeOfDay above) -- shouldBroadcast only returns true once per real state
    // CHANGE (first activation, or a future setState() call from an admin/game-mode toggle), so this is a
    // cheap dirty-flag check every tick, not a real broadcast most ticks. No-op when the world never
    // opted in (worldDef.terrain.weather.serverAuthoritative!==true).
    if (players.length > 0 && serverWeather.shouldBroadcast()) {
      connections.broadcast(MSG.WEATHER_SYNC, serverWeather.getSyncPayload())
    }
    if (tick % (tickRate * AUTO_SAVE_INTERVAL) === 0 && tick > 0) {
      try { deps.onAutoSave?.() } catch (_) {}
    }
    for (const id of snapDeps.playerEntityMaps.keys()) { if (!playerManager.getPlayer(id)) { snapDeps.playerEntityMaps.delete(id); playerIdleCounts.delete(id); playerAccumDt.delete(id); clearPlayerPriorityAccumulator(id); playerScratch.delete(id); snapState.playerLastTick.delete(id); snapState.playerCell.delete(id) } }
    const t5 = performance.now()
    try { appRuntime._drainReloadQueue() } catch (e) { console.error('[TickHandler] reload queue error:', e.message) }
    if (players.length > 0) {
      profileSum += t5-t0; profileSumSnap += t5-t4; profileSumPhys += t3-t2; profileSumMv += t1-t0; profileCount++
      // server-scale-prometheus-metrics-endpoint-dashboard: same real per-phase durations the existing
      // profileSum* accumulators/console.log(_PROFILE) already compute, additionally fed into the
      // Prometheus histogram registry so a scrape sees the full distribution, not just a periodic log line.
      recordTickPhase('total', t5-t0); recordTickPhase('mv', t1-t0); recordTickPhase('phys', t3-t2); recordTickPhase('snap', t5-t4)
    }
    // rate-limited overrun warning: silent tick overrun is what causes pacing to fall behind under load with no visibility
    const tickBudgetMs = 1000 / tickRate
    if (t5 - t0 > tickBudgetMs * 2 && serverNow - _lastBudgetWarnMs > 1000) {
      _lastBudgetWarnMs = serverNow
      console.warn(`[TickHandler] tick ${tick} overran budget: ${(t5-t0).toFixed(2)}ms > ${(tickBudgetMs*2).toFixed(2)}ms (budget ${tickBudgetMs.toFixed(2)}ms) players:${players.length}`)
    }
    if (_PROFILE && ++profileLog % KEYFRAME_INTERVAL === 0) {
      const total=t5-t0, mem=typeof process!=='undefined'?process.memoryUsage():{heapUsed:0,rss:0,external:0,arrayBuffers:0}, avg=n => profileCount>0?(n/profileCount).toFixed(2):'0'
      const mb=n=>(n/1048576).toFixed(1)
      const dynIds=appRuntime._dynamicEntityIds?.size||0, activeDyn=appRuntime.getActiveDynamicIds()?.size||0
      const avgTotal=avg(profileSum),avgSnap=avg(profileSumSnap),avgPhys=avg(profileSumPhys),avgMv=avg(profileSumMv)
      profileSum=0; profileSumSnap=0; profileSumPhys=0; profileSumMv=0; profileCount=0
      let idleSkipped = 0; if (players.length > 0) for (const c of playerIdleCounts.values()) if (c >= 2) idleSkipped++
      const physSkipped = players.length > 0 ? playerAccumDt.size : 0
      try { console.log(`[tick-profile] tick:${tick} players:${players.length} idle:${idleSkipped} physSkip:${physSkipped} entities:${appRuntime.entities.size} dynIds:${dynIds} activeDyn:${activeDyn} total:${total.toFixed(2)}ms(avg:${avgTotal}) | mv:${(t1-t0).toFixed(2)}(avg:${avgMv}) col:${(t2-t1).toFixed(2)} phys:${(t3-t2).toFixed(2)}(avg:${avgPhys}) app:${(t4-t3).toFixed(2)} sync:${(appRuntime._lastSyncMs||0).toFixed(2)} respawn:${(appRuntime._lastRespawnMs||0).toFixed(2)} spatial:${(appRuntime._lastSpatialMs||0).toFixed(2)} col2:${(appRuntime._lastCollisionMs||0).toFixed(2)} int:${(appRuntime._lastInteractMs||0).toFixed(2)} snap:${(t5-t4).toFixed(2)}(avg:${avgSnap}) | heap:${mb(mem.heapUsed)}MB rss:${mb(mem.rss)}MB ext:${mb(mem.external)}MB ab:${mb(mem.arrayBuffers)}MB`) } catch (_) {}
    }
  }

  // Attached (not just closed-over) so a late-joining player's connect handler -- ServerHandlers.js's
  // onClientConnect, which runs OUTSIDE this closure -- can read the CURRENT fraction for a one-time
  // join-time send, mirroring the existing ctx._terrainStreamer attach-after-create convention (see
  // WorkerEntry.js/ServerAPI.js). onTick itself is unused as a namespace by any caller today (setTickHandler
  // only ever calls it as a plain function), so this adds a read surface without touching that contract.
  onTick.serverTimeOfDay = serverTimeOfDay
  // server-scale-prometheus-metrics-endpoint-dashboard: a live read of the SAME profileSum*/profileCount
  // accumulators the existing _PROFILE console.log path already computes unconditionally every tick (see
  // the profileSum block above -- computed regardless of _PROFILE, only the console.log itself is gated).
  // Deliberately does NOT reset the accumulators on read (unlike the console.log path, which resets every
  // KEYFRAME_INTERVAL ticks) -- a Prometheus scrape is pull-based and may poll at an arbitrary cadence
  // uncoordinated with KEYFRAME_INTERVAL, so resetting on read here would make one scraper's read starve
  // a concurrent scraper's window; ServerAPI.js's /metrics route instead reads this on every request and
  // reports the average over however many ticks have accumulated since the last natural profileLog reset.
  onTick.getMetrics = () => ({
    avgTotalMs: profileCount > 0 ? profileSum / profileCount : 0,
    avgMvMs: profileCount > 0 ? profileSumMv / profileCount : 0,
    avgPhysMs: profileCount > 0 ? profileSumPhys / profileCount : 0,
    avgSnapMs: profileCount > 0 ? profileSumSnap / profileCount : 0,
    sampleCount: profileCount,
  })
  // rollback-tickhandler-resimulate-loop: exposes the pure deterministic-simulation subset (see
  // simulateTick's own header comment) so RollbackLoop.js can replay ticks with corrected input without
  // re-triggering this handler's network-broadcast side effects. Same attach-after-create convention as
  // serverTimeOfDay/serverWeather below -- a plain function property on the returned onTick closure.
  onTick.simulateTick = simulateTick
  // rollback-tickhandler-resimulate-loop: playerIdleCounts/playerAccumDt (processPlayerMovement's physics-
  // decimation scheduling state, see the isIdle/accumDt block above) are tick-history-dependent hidden state
  // that is NOT part of PhysicsWorld.snapshotBodies/snapshotCharacters -- a real bug found+fixed while
  // building RollbackLoop.js's live witness: resimulating from a restored physics snapshot WITHOUT also
  // restoring these two maps to their tick-30 values reproduced a real 0.27m/1.6(m/s) divergence even when
  // replaying the IDENTICAL scripted input the original forward run used, because the maps still held their
  // post-tick-40 values from the original run (an idle player who had already accumulated 9 skipped ticks'
  // worth of decimation state by tick 40 does not skip-decimate the same way on a resim starting fresh from
  // tick 30). snapshotSimState/restoreSimState expose exactly these two Maps (cloned, never the live
  // reference) so a rollback caller saves/restores them in lockstep with the physics snapshot every tick.
  onTick.snapshotSimState = () => ({ playerIdleCounts: new Map(playerIdleCounts), playerAccumDt: new Map(playerAccumDt) })
  onTick.restoreSimState = (s) => {
    if (!s) return
    playerIdleCounts.clear(); for (const [k, v] of s.playerIdleCounts) playerIdleCounts.set(k, v)
    playerAccumDt.clear(); for (const [k, v] of s.playerAccumDt) playerAccumDt.set(k, v)
  }
  // Same attach-after-create convention as serverTimeOfDay above, for the identical reason: ServerHandlers.js's
  // onClientConnect (outside this closure) needs to read the CURRENT weather state for a one-time
  // join-time backfill send.
  onTick.serverWeather = serverWeather
  // lockstep-desync-wireweave-transport-and-tickhandler-wiring: the TickHandler-side half of wiring
  // DesyncDetector.js/LockstepChecksum.js into a real lockstep peer's tick loop, reusing simulateTick
  // exactly as RollbackLoop.js's resimulate path already does above (the pure deterministic-simulation
  // subset, zero network-broadcast side effects -- a lockstep peer's own tick loop, unlike this file's
  // own onTick, never calls buildAndSendSnapshots at all: a P2P mesh peer has no "clients to snapshot",
  // every peer IS a full simulation, see LockstepTickSystem.js's header comment for why this driver
  // exists as a wholly separate onTick(tick,dt) consumer from the server-authoritative one above).
  //
  // simulateTickWithChecksum(tick, dt, players): runs simulateTick unchanged, then -- only on ticks
  // detector.isChecksumTick(tick) selects (see DesyncDetector.js's own cadence-owning comment) --
  // computes this peer's own checksumBodies(tick, physics.snapshotBodies()) and reports it through
  // `desyncTransport.reportLocalChecksum`, which both broadcasts it to the mesh AND feeds the local
  // detector, matching submitLocalInput's identical local-write-goes-through-the-same-path discipline
  // in LockstepInputTransport.js. Returns the detector's resolution result ({status:'verified'|'desync',
  // ...}) on a checksum tick that JUST became fully resolved by this peer's OWN report (the common case
  // when this peer is the last of the roster to report), or null on every other tick -- a caller that
  // wants to observe every resolution (including ones resolved by a remote peer's LATER-arriving report)
  // should use detector.onVerified/onDesync instead, exactly as constructed; this return value is a
  // same-tick convenience for a caller that only cares about its own report's synchronous outcome.
  onTick.attachDesyncChecksum = (desyncTransport, checksumFn) => {
    const detector = desyncTransport.detector
    const physics_ = desyncTransport.physics
    const computeChecksum = checksumFn || ((t) => checksumBodies(t, physics_.snapshotBodies()))
    return function simulateTickWithChecksum(tick, dt, players) {
      simulateTick(tick, dt, players)
      if (!detector.isChecksumTick(tick)) return null
      const checksum = computeChecksum(tick)
      return desyncTransport.reportLocalChecksum(tick, checksum)
    }
  }
  return onTick
}
