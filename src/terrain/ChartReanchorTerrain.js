import { createPlanetFrame } from './PlanetFrame.js'
import { createFieldLattice, tiltDegBetween, LATTICE_FOLLOW_TILT_DEG, LATTICE_RESET_FORCED_TILT_DEG, RESET_SURFACE_STEP_BOUND_M } from './FieldLattice.js'
import { snapshotChart, createChartTransfer } from '../shared/chartAnchor.js'
import { seaLevelDirOf, seaLevelXZOfDir } from './ChartLocalPoint.js'

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const SAME_ANCHOR_EPS = 1e-9
const SURFACE_PROBE_HEIGHT_M = 30
const SURFACE_PROBE_RANGE_M = 80
const SURFACE_PROBE_SKIP_M = 0.01
const SURFACE_PROBE_MAX_HITS = 4

const sameDir = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < SAME_ANCHOR_EPS
const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

export function createTerrainReanchor({ frame, sampler, offsetY, reliefScale, physics, heightStreamer, colliderStreamers, getPlayers, blockers }) {
  let prepared = null, preparing = null, prepareFailure = null, followDecided = false, pendingResetStepM = 0
  const costs = []

  function permanentBlocker() {
    for (const blocker of blockers) {
      const reason = blocker()
      if (reason) return reason
    }
    return null
  }

  function playersOn(snapshot, players) {
    const from = snapshotChart(frame)
    return players.map(([x, z]) => seaLevelXZOfDir(snapshot, seaLevelDirOf(from, x, z)))
  }

  function coveredBy(set, playersNew) {
    return playersNew.every(p => set.fields.some(f => chebyshev(p, f.center) <= heightStreamer.coverRadius))
  }

  function beginPrepare(targetDir, players) {
    const baseEpoch = frame.chartEpoch
    const shadow = createPlanetFrame({ sampler, anchorDir: targetDir, offsetY, reliefScale })
    const shadowSnapshot = snapshotChart(shadow)
    const playersNew = playersOn(shadowSnapshot, players)
    const t0 = _now()
    const job = { targetDir, baseEpoch, promise: null }
    job.promise = heightStreamer.prepareFields({
      players: playersNew,
      heightFn: (x, z) => shadow.groundHeightLocal(x, z),
      isAborted: () => frame.chartEpoch !== baseEpoch,
    }).then(set => {
      preparing = null
      if (!set) return
      prepared = { ...set, targetDir, baseEpoch, shadowSnapshot, prepareMs: _now() - t0 }
    }).catch(err => {
      preparing = null
      prepareFailure = err.message
      console.error('[terrain] chart reanchor field prepare failed:', err.message)
    })
    preparing = job
  }

  function terrainSurfaceY(x, z) {
    let originY = heightStreamer.liveHeightFn(x, z) + SURFACE_PROBE_HEIGHT_M
    for (let i = 0; i < SURFACE_PROBE_MAX_HITS; i++) {
      const r = physics.raycast([x, originY, z], [0, -1, 0], SURFACE_PROBE_RANGE_M)
      if (!r.hit) return null
      if (physics.bodyMeta.get(r.bodyId)?.shape === 'heightfield') return r.position[1]
      originY = r.position[1] - SURFACE_PROBE_SKIP_M
    }
    return null
  }

  function resetSurfaceStepM(players) {
    const toTarget = createChartTransfer(snapshotChart(frame), prepared.shadowSnapshot)
    let worst = 0
    for (const [x, z] of players) {
      const y = terrainSurfaceY(x, z)
      if (y === null) continue
      const p = toTarget.point([x, y, z])
      const s = heightStreamer.preparedSurfaceY(prepared, p[0], p[2])
      if (s !== null) worst = Math.max(worst, Math.abs(p[1] - s))
    }
    return worst
  }

  function resetGate(tilt, players) {
    pendingResetStepM = resetSurfaceStepM(players)
    if (pendingResetStepM <= RESET_SURFACE_STEP_BOUND_M || tilt > LATTICE_RESET_FORCED_TILT_DEG) return null
    return 'waiting-for-quiet-surface'
  }

  function gate({ decision }) {
    const blocker = permanentBlocker()
    if (blocker) return blocker
    if (prepareFailure) { const reason = `heightfield-prepare-failed: ${prepareFailure}`; prepareFailure = null; return reason }
    const latticeUp = heightStreamer.lattice ? heightStreamer.lattice.anchor.up : frame.up
    const tilt = tiltDegBetween(latticeUp, decision.anchorDir)
    followDecided = tilt <= LATTICE_FOLLOW_TILT_DEG
    if (followDecided) { prepared = null; return null }
    const players = getPlayers()
    if (prepared && (prepared.baseEpoch !== frame.chartEpoch || !sameDir(prepared.targetDir, decision.anchorDir))) prepared = null
    if (prepared && !coveredBy(prepared, playersOn(prepared.shadowSnapshot, players))) prepared = null
    if (prepared) return resetGate(tilt, players)
    if (preparing && (preparing.baseEpoch !== frame.chartEpoch || !sameDir(preparing.targetDir, decision.anchorDir))) return 'heightfields-preparing-for-another-anchor'
    if (!preparing) beginPrepare(decision.anchorDir, players)
    return 'heightfields-not-ready'
  }

  function followLattice(event) {
    if (!heightStreamer.lattice) heightStreamer.setLattice(createFieldLattice({ sampler, offsetY, reliefScale, anchor: event.from, liveFrame: frame, liveHeightFn: heightStreamer.liveHeightFn }))
    else heightStreamer.placeAllFields()
    return { installed: 0, removed: 0, retransformed: heightStreamer.fields.length, tiltDeg: heightStreamer.lattice.tiltDeg }
  }

  let migratedEpoch = -1
  function migrate(event) {
    if (event.epoch === migratedEpoch) return
    if (!followDecided && (!prepared || prepared.baseEpoch + 1 !== event.epoch)) throw new Error(`terrain reanchor to epoch ${event.epoch} has no prepared heightfields for it (prepared base epoch ${prepared ? prepared.baseEpoch : 'none'})`)
    const t0 = _now()
    const fields = followDecided ? followLattice(event) : heightStreamer.installPrepared(prepared)
    const t1 = _now()
    const moved = colliderStreamers.map(s => s.reanchor(event))
    const t2 = _now()
    costs.push({ epoch: event.epoch, fieldInstallMs: t1 - t0, colliderTransformMs: t2 - t1, totalMs: t2 - t0, fields, collidersMoved: moved, prepareMs: prepared ? prepared.prepareMs : 0, mode: followDecided ? 'follow-lattice' : 'reset-lattice', resetStepMm: followDecided ? 0 : pendingResetStepM * 1e3 })
    prepared = null
    migratedEpoch = event.epoch
  }

  return { gate, migrate, costs, get pendingResetStepMm() { return pendingResetStepM * 1e3 }, get preparing() { return !!preparing }, get prepared() { return prepared } }
}
