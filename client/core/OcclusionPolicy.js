// OcclusionPolicy -- ONE shared occlusion-verdict policy, extracted from TerrainOcclusion.js and
// SceneOcclusion.js, which independently hand-evolved the same decision shape (streak-based hide,
// eyeAtIssue expiry, staleness fail-open, anomaly guard) with divergent constants and divergent
// bug-fix vintages -- e.g. SceneOcclusion grew a symmetric 2-resolve UNHIDE_STREAK + a
// STALE_RESOLVE_FRAMES fail-open + an ANOMALY_FRACTION guard that TerrainOcclusion never received,
// while TerrainOcclusion's eyeAtIssue distance-expiry was never ported the other way. Per
// constraints.md: one shared module, no hand-copied hysteresis variants; only the numeric constants
// differ per consumer, in a config object.
//
// This module owns per-record VERDICT state transitions only -- never GPU query issue/resolve
// mechanics (raw gl.beginQuery/drawElements, round-robin budget cursors, box geometry). Each caller
// still owns its own query submission (terrain: raw WebGL2 in TerrainOcclusion.js; vegetation/rocks:
// the vendored streaming-gltf OcclusionQueryTier) and calls into this module once per candidate,
// per frame, with that candidate's fresh-resolve outcome (or "no fresh resolve this frame").
//
// createOcclusionPolicy(config) returns per-record helpers; callers keep their own Map<key, record>
// where `record` is whatever shape they already use, as long as it carries the fields this module
// reads/writes (documented per-function below) -- no forced record class, since TerrainOcclusion's
// records also carry query/pending/center/size fields this module has no reason to know about.

export function createOcclusionPolicy(config = {}) {
  // Streak-based hide: N consecutive HIDDEN resolves before a candidate is treated as occluded.
  // Both source systems used 2; kept as the shared default, per-consumer overridable.
  const HIDE_STREAK = config.hideStreak ?? 2
  // Symmetric un-hide streak: N consecutive VISIBLE resolves before a hidden candidate is
  // un-occluded. SceneOcclusion introduced this (UNHIDE_STREAK=2) specifically because
  // query-budget starvation makes resolves sparse -- one noisy resolve on either side of a real
  // verdict must not flip state. TerrainOcclusion's original un-hide was IMMEDIATE (un-cull on the
  // very first visible resolve, its own comment calling that "damps oscillation" -- true only
  // against a hide-side oscillator, not a resolve-noise oscillator). Default to the symmetric,
  // more conservative behavior; a consumer that legitimately wants immediate un-hide (e.g. it
  // issues a query every frame with no round-robin starvation, so resolve noise isn't a concern)
  // sets unhideStreak: 1 explicitly, which reproduces TerrainOcclusion's prior behavior exactly.
  const UNHIDE_STREAK = config.unhideStreak ?? 2
  // eyeAtIssue distance expiry: a HIDDEN verdict is only valid for the camera pose it was issued
  // from. If the eye has moved past `max(expireMinM, recordSize * expireSizeMult)` since the query
  // was issued, fail the verdict open (treat as visible) rather than trust a resolve describing a
  // stale viewpoint. TerrainOcclusion always had this; SceneOcclusion never did (its candidates —
  // vegetation/rock chunks — don't carry a per-candidate `size`+`eyeAtIssue` the same way). Off by
  // default (enableEyeExpiry:false) since it needs the caller to actually track eyeAtIssue/size
  // per record; TerrainOcclusion opts in explicitly.
  const ENABLE_EYE_EXPIRY = config.enableEyeExpiry ?? false
  const EXPIRE_MIN_M = config.expireMinM ?? 3
  const EXPIRE_SIZE_MULT = config.expireSizeMult ?? 1.5
  // Stability gate for verdict flips: require N consecutive frames with the same occlusion query
  // result before accepting a verdict change. Prevents alternating jitter (visible/hidden/visible)
  // from rapid query oscillation (floating-point precision in terrain height, depth-buffer rounding).
  // Default 2 (accept on second stable frame); close geometry may need higher values (4-6) to dampen
  // high-frequency depth-jitter oscillation.
  const STABILITY_GATE = config.stabilityGate ?? 2
  // Stale-resolve fail-open: a HIDDEN candidate that goes this many frames without a FRESH resolve
  // arriving (distinct from eyeAtIssue expiry -- this fires even for a stationary camera, purely
  // from query-budget starvation never reaching this candidate) re-earns its hysteresis from a
  // clean slate rather than riding a frozen hidden verdict forever. SceneOcclusion's
  // STALE_RESOLVE_FRAMES=90; TerrainOcclusion's closest equivalent is its rebuild-staleness check
  // (see below) which fires on a DIFFERENT signal (record unseen by a rebuild, not resolve-count
  // stalled) -- both are kept as distinct, independently configurable fail-opens since they detect
  // different failure modes and a consumer may need either, both, or neither.
  const STALE_RESOLVE_FRAMES = config.staleResolveFrames ?? 90
  // Rebuild-staleness fail-open: a record not refreshed by the candidate-producing rebuild in N
  // frames stops receiving queries; if still hidden after a further M frames with zero rebuild
  // contact, fail it open. TerrainOcclusion-specific shape (quadtree leaves only exist while a
  // rebuild's predicate touches them); off by default, TerrainOcclusion opts in via
  // isStaleFromRebuild(record, frameCounter) below.
  const REBUILD_STOP_QUERY_FRAMES = config.rebuildStopQueryFrames ?? 8
  const REBUILD_FAIL_OPEN_FRAMES = config.rebuildFailOpenFrames ?? 16
  // Anomaly-fraction guard: a real view never legitimately occludes ~every candidate at once. If a
  // resolved batch marks an implausibly large fraction occluded, the query mechanism itself is
  // producing bad verdicts (see cull-false-occlusion-root-cause) -- reset every streak and fail the
  // WHOLE BATCH open rather than hide the visible world for a frame. Off by default (needs a
  // caller-computed fraction across its own candidate set); SceneOcclusion opts in.
  const ANOMALY_FRACTION = config.anomalyFraction ?? 0.30
  const ANOMALY_MIN_CANDIDATES = config.anomalyMinCandidates ?? 32

  // Per-record streak/verdict fields this module reads and writes, on whatever object the caller
  // passes as `rec` (own Map value type). Documented shape (subset used):
  //   rec.streak (number)      -- consecutive-hidden-resolve count
  //   rec.unstreak (number)    -- consecutive-visible-resolve count
  //   rec.hidden (boolean)     -- current verdict
  //   rec.seen (number)        -- last-observed tier resolve count (fresh-resolve detection)
  //   rec.staleFrames (number) -- frames since a fresh resolve last arrived while hidden
  //   rec.stableCount (number) -- frames with same verdict (depth-jitter stability gate)

  function ensureRecord(rec) {
    if (rec.streak === undefined) rec.streak = 0
    if (rec.unstreak === undefined) rec.unstreak = 0
    if (rec.hidden === undefined) rec.hidden = false
    if (rec.seen === undefined) rec.seen = 0
    if (rec.staleFrames === undefined) rec.staleFrames = 0
    if (rec.stableCount === undefined) rec.stableCount = 0
    return rec
  }

  // Advance one record's hysteresis given this frame's resolve outcome. `resolveCount` is a
  // caller-tracked monotonic counter (only advances on a FRESH tier resolve, mirroring both source
  // systems' "don't collapse the streak into per-frame flips under a stale re-read" discipline) --
  // pass the same value twice in a row to signal "no fresh resolve this frame" (staleness path).
  // `occludedThisResolve` is only consulted when resolveCount actually advanced.
  // Depth-jitter stability gate: verdicts that alternate every frame (visible/hidden/visible) are
  // gated by stableCount -- require N frames of the SAME outcome before accepting a verdict flip.
  // This prevents alternating query results (from floating-point jitter in dynamic terrain height)
  // from creating the -2nd frame flicker pattern.
  function advance(rec, resolveCount, occludedThisResolve) {
    ensureRecord(rec)
    let flipped = false
    if (resolveCount !== rec.seen) {
      rec.seen = resolveCount
      rec.staleFrames = 0
      // Track stability: has the verdict stayed the same across this resolve?
      const verdictNow = occludedThisResolve ? 'hidden' : 'visible'
      const verdictBefore = rec.hidden ? 'hidden' : 'visible'
      if (verdictNow === verdictBefore) {
        // Verdict unchanged: increment stability counter
        rec.stableCount = (rec.stableCount || 0) + 1
      } else {
        // Verdict flipped: reset stability counter (alternating jitter detected)
        rec.stableCount = 1
      }
      // Only allow streak updates if verdict is stable (not on the very first flip)
      if (rec.stableCount >= STABILITY_GATE) {
        if (occludedThisResolve) {
          rec.streak++; rec.unstreak = 0
          if (rec.streak >= HIDE_STREAK && !rec.hidden) { rec.hidden = true; flipped = true }
        } else {
          rec.unstreak++; rec.streak = 0
          if (rec.unstreak >= UNHIDE_STREAK && rec.hidden) { rec.hidden = false; flipped = true }
        }
      }
    } else if (rec.hidden) {
      rec.staleFrames++
      if (rec.staleFrames > STALE_RESOLVE_FRAMES) {
        rec.hidden = false; rec.streak = 0; rec.unstreak = 0; rec.stableCount = 0; flipped = true
        return { hidden: rec.hidden, flipped, failOpen: 'stale-resolve' }
      }
    }
    return { hidden: rec.hidden, flipped, failOpen: null }
  }

  // eyeAtIssue distance expiry -- caller supplies the eye position at query-issue time
  // (rec.eyeAtIssue, a caller-owned [x,y,z]) and the current eye position; returns true if the
  // verdict should fail open (eye moved too far since issue). No-op (returns false) if
  // enableEyeExpiry is off or inputs are missing -- callers that don't opt in never pay this check.
  function checkEyeExpiry(rec, eyeNow, sizeHint) {
    if (!ENABLE_EYE_EXPIRY || !rec.hidden || !eyeNow || !rec.eyeAtIssue) return false
    if (!eyeMovedPastExpiry(rec, eyeNow, sizeHint)) return false
    rec.hidden = false; rec.streak = 0; rec.unstreak = 0
    return true
  }

  // Pure predicate: did the eye move past this record's expiry distance since query-issue time?
  // Same EXPIRE_MIN_M/EXPIRE_SIZE_MULT the config already holds, single-sourced. No rec.hidden guard
  // and no mutation -- for the resolve-time trigger (a FRESH occluded result whose eyeAtIssue is stale),
  // distinct from checkEyeExpiry's pending-verdict trigger which fails an already-hidden record open.
  function eyeMovedPastExpiry(rec, eyeNow, sizeHint) {
    if (!eyeNow || !rec.eyeAtIssue) return false
    const px = eyeNow[0] - rec.eyeAtIssue[0], py = eyeNow[1] - rec.eyeAtIssue[1], pz = eyeNow[2] - rec.eyeAtIssue[2]
    const expireM = Math.max(EXPIRE_MIN_M, (sizeHint || 1) * EXPIRE_SIZE_MULT)
    return px * px + py * py + pz * pz > expireM * expireM
  }

  // Rebuild-staleness fail-open, TerrainOcclusion-shaped: `framesSinceSeen` is frameCounter -
  // rec.lastSeenFrame (caller-tracked). Returns { skipQuery, failOpen } -- skipQuery true past
  // REBUILD_STOP_QUERY_FRAMES (caller should stop issuing queries for this record), failOpen true
  // once REBUILD_FAIL_OPEN_FRAMES also elapses while still hidden.
  function checkRebuildStaleness(rec, framesSinceSeen) {
    const skipQuery = framesSinceSeen > REBUILD_STOP_QUERY_FRAMES
    let failOpen = false
    if (skipQuery && rec.hidden && framesSinceSeen > REBUILD_FAIL_OPEN_FRAMES) {
      rec.hidden = false; rec.streak = 0; rec.unstreak = 0
      failOpen = true
    }
    return { skipQuery, failOpen }
  }

  // Anomaly-fraction guard over a whole resolved batch. `occludedWeight`/`liveWeight` let a caller
  // weight by instance count (SceneOcclusion's fix for "1.7% of chunks but 51.4% of instances
  // occluded" undercounting) or just pass counts for unweighted candidates. Returns true if the
  // batch should be treated as anomalous (caller should reset every record's streak/hidden and
  // apply an empty occluded set for this frame instead of trusting the batch).
  function isAnomalousBatch(liveCount, liveWeight, occludedWeight) {
    if (liveCount < ANOMALY_MIN_CANDIDATES) return false
    const fraction = liveWeight > 0 ? occludedWeight / liveWeight : 0
    return fraction >= ANOMALY_FRACTION
  }

  function resetRecord(rec) {
    rec.streak = 0; rec.unstreak = 0; rec.hidden = false; rec.staleFrames = 0; rec.stableCount = 0
  }

  return {
    ensureRecord,
    advance,
    checkEyeExpiry,
    eyeMovedPastExpiry,
    checkRebuildStaleness,
    isAnomalousBatch,
    resetRecord,
    config: { HIDE_STREAK, UNHIDE_STREAK, ENABLE_EYE_EXPIRY, EXPIRE_MIN_M, EXPIRE_SIZE_MULT, STALE_RESOLVE_FRAMES, REBUILD_STOP_QUERY_FRAMES, REBUILD_FAIL_OPEN_FRAMES, ANOMALY_FRACTION, ANOMALY_MIN_CANDIDATES },
  }
}

// ---- Super-cell occlusion candidates (shared by Vegetation.js / Rocks.js / Grass.js) ------------------
//
// One occlusion-query candidate per 128m SUPER-CELL (cellsPerSide=4 -> 16 of the 32m streaming chunks)
// instead of one per chunk. With ~1750 per-chunk candidates and a 16-query/frame round-robin, a given
// candidate was only re-queried every ~110 frames -- past OcclusionPolicy's staleResolveFrames=60 fail-open
// -- so verdicts never held and the full query cost bought essentially no culling. ~16x fewer candidates
// refresh every few frames, so a HIDDEN verdict can actually persist. A coarser box (the union of its
// member chunks' real AABBs) is a strictly more conservative occludee: it can only ever hide LESS than
// per-chunk boxes did, never more -- zero visual risk. Membership changes (a chunk streaming in/out of a
// super-cell) re-key the candidate (fresh proxy object + gen-suffixed key), so the shared SceneOcclusion
// verdict for the old key is released and the new box starts fail-open (visible) -- again hide-less.
//
// The candidate array is identity-cached and rebuilt only on a loaded-set change (SceneOcclusion.js
// relies on the identity to skip its own per-frame rebuild). applyOcclusion is a DELTA against the last
// applied hidden set (O(hidden + occluded) per frame, not O(loaded chunks)): a subsystem only touches
// instance visibility for super-cells whose verdict actually flipped.
import * as THREE from 'three'
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)   // ONE shared unit-cube geo for every proxy (never rendered; OcclusionQueryTier only reads its bounds)
const _occBoxMat = new THREE.MeshBasicMaterial()

export function createOcclusionSuperCells(opts = {}) {
  const prefix = opts.prefix || 'o'
  const cellsPerSide = opts.cellsPerSide || 4
  const MARGIN = Number.isFinite(opts.margin) ? opts.margin : 2
  const LIFT_MIN = Number.isFinite(opts.liftMin) ? opts.liftMin : 2
  const countOf = typeof opts.countOf === 'function' ? opts.countOf : () => 1
  const supers = new Map()     // superId (int) -> rec
  const byCell = new Map()     // cell key (int) -> rec
  const byKey = new Map()      // candidate key (string) -> rec
  const hidden = new Set()     // recs whose members are currently hidden by the last applyOcclusion
  let cands = null
  let gen = 0

  function superIdOf(cx, cz) {
    const sx = Math.floor(cx / cellsPerSide), sz = Math.floor(cz / cellsPerSide)
    return ((sx + 32768) & 0xffff) * 65536 + ((sz + 32768) & 0xffff)
  }

  function add(cellKey, cx, cz, cell) {
    const id = superIdOf(cx, cz)
    let rec = supers.get(id)
    if (!rec) { rec = { id, members: new Map(), proxy: null, key: null, dirty: true }; supers.set(id, rec) }
    rec.members.set(cellKey, cell)
    byCell.set(cellKey, rec)
    rec.dirty = true
    cands = null
  }

  function remove(cellKey) {
    const rec = byCell.get(cellKey)
    if (!rec) return
    byCell.delete(cellKey)
    rec.members.delete(cellKey)
    if (rec.members.size === 0) {
      supers.delete(rec.id)
      if (rec.key) byKey.delete(rec.key)
      hidden.delete(rec)
    } else rec.dirty = true
    cands = null
  }

  function rebuildProxy(rec) {
    // union of the members' real placed-instance AABBs
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    let instanceCount = 0
    for (const cell of rec.members.values()) {
      const a = cell.aabbMin, b = cell.aabbMax
      if (a[0] < minX) minX = a[0]; if (a[1] < minY) minY = a[1]; if (a[2] < minZ) minZ = a[2]
      if (b[0] > maxX) maxX = b[0]; if (b[1] > maxY) maxY = b[1]; if (b[2] > maxZ) maxZ = b[2]
      instanceCount += countOf(cell)
    }
    const root = new THREE.Object3D()
    // must have a real (unit-box) mesh child: OcclusionQueryTier's Box3.setFromObject walks geometry not
    // transforms, so a bare Object3D yields an empty box and the candidate never queries
    const boxMesh = new THREE.Mesh(_occBoxGeo, _occBoxMat)
    boxMesh.visible = false
    boxMesh.raycast = () => {}
    root.add(boxMesh)
    // margin+lift: a box flush with the exact ground-anchored AABB false-occludes at steep downward
    // viewing angles / close range (the "disappear on approach" defect). aabbMin/aabbMax bracket the REAL
    // placed elevation extent, so LIFT only needs to cover half the box's own height (proportional).
    const rawH = maxY - minY
    const LIFT = Math.max(LIFT_MIN, rawH * 0.5)
    root.position.set((minX + maxX) / 2, (minY + maxY) / 2 + LIFT, (minZ + maxZ) / 2)
    root.scale.set(Math.max(maxX - minX + MARGIN * 2, 1e-3), Math.max(rawH + MARGIN * 2, 1e-3), Math.max(maxZ - minZ + MARGIN * 2, 1e-3))
    root.updateMatrixWorld(true)
    if (rec.key) byKey.delete(rec.key)
    rec.key = prefix + rec.id + ':' + (++gen)
    rec.proxy = { root, key: rec.key, instanceCount }
    byKey.set(rec.key, rec)
    rec.dirty = false
  }

  function candidates() {
    if (cands) return cands
    const out = []
    for (const rec of supers.values()) {
      if (rec.dirty || !rec.proxy) rebuildProxy(rec)
      out.push(rec.proxy)
    }
    cands = out
    return out
  }

  // setHidden(cell, hidden) is called ONLY for member cells of a super-cell whose verdict flipped.
  function applyOcclusion(occludedKeys, setHidden) {
    for (const rec of hidden) {
      if (occludedKeys.has(rec.key)) continue
      hidden.delete(rec)
      for (const cell of rec.members.values()) setHidden(cell, false)
    }
    if (occludedKeys.size === 0) return
    for (const key of occludedKeys) {
      const rec = byKey.get(key)
      if (!rec || hidden.has(rec)) continue
      hidden.add(rec)
      for (const cell of rec.members.values()) setHidden(cell, true)
    }
  }

  function clear() { supers.clear(); byCell.clear(); byKey.clear(); hidden.clear(); cands = null }

  return { add, remove, candidates, applyOcclusion, clear, get superCount() { return supers.size }, get hiddenCount() { return hidden.size } }
}
