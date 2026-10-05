import { createPlanetFrame } from './PlanetFrame.js'
import { snapshotChart } from '../shared/chartAnchor.js'
import { seaLevelDirOf, seaLevelXZOfDir } from './ChartLocalPoint.js'

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const SAME_ANCHOR_EPS = 1e-9

const sameDir = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < SAME_ANCHOR_EPS
const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

export function createTerrainReanchor({ frame, sampler, offsetY, reliefScale, physics, heightStreamer, colliderStreamers, getPlayers, blockers }) {
  let prepared = null, preparing = null, prepareFailure = null
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

  function gate({ decision }) {
    const blocker = permanentBlocker()
    if (blocker) return blocker
    if (prepareFailure) { const reason = `heightfield-prepare-failed: ${prepareFailure}`; prepareFailure = null; return reason }
    const players = getPlayers()
    if (prepared && (prepared.baseEpoch !== frame.chartEpoch || !sameDir(prepared.targetDir, decision.anchorDir))) prepared = null
    if (prepared && !coveredBy(prepared, playersOn(prepared.shadowSnapshot, players))) prepared = null
    if (prepared) return null
    if (preparing && (preparing.baseEpoch !== frame.chartEpoch || !sameDir(preparing.targetDir, decision.anchorDir))) return 'heightfields-preparing-for-another-anchor'
    if (!preparing) beginPrepare(decision.anchorDir, players)
    return 'heightfields-not-ready'
  }

  let migratedEpoch = -1
  function migrate(event) {
    if (event.epoch === migratedEpoch) return
    if (!prepared || prepared.baseEpoch + 1 !== event.epoch) throw new Error(`terrain reanchor to epoch ${event.epoch} has no prepared heightfields for it (prepared base epoch ${prepared ? prepared.baseEpoch : 'none'})`)
    const t0 = _now()
    const fields = heightStreamer.installPrepared(prepared)
    const t1 = _now()
    const moved = colliderStreamers.map(s => s.reanchor(event))
    const t2 = _now()
    costs.push({ epoch: event.epoch, fieldInstallMs: t1 - t0, colliderTransformMs: t2 - t1, totalMs: t2 - t0, fields, collidersMoved: moved, prepareMs: prepared.prepareMs })
    prepared = null
    migratedEpoch = event.epoch
  }

  return { gate, migrate, costs, get preparing() { return !!preparing }, get prepared() { return prepared } }
}
