import { chartAnchorForDir } from './chartAnchor.js'
import { chartAnchorDecision, CHART_REANCHOR_HYSTERESIS_DEG } from './chartReanchorPolicy.js'

export const CLUSTER_STAY_FACTOR = 1.25
export const CLUSTER_JOIN_FACTOR = 0.8

const byId = (a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)

function unitDir(d) {
  if (!Array.isArray(d) || d.length !== 3) return null
  const l = Math.hypot(d[0], d[1], d[2])
  return Number.isFinite(l) && l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : null
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function centroidOf(members) {
  let x = 0, y = 0, z = 0
  for (const m of members) { x += m.dir[0]; y += m.dir[1]; z += m.dir[2] }
  const l = Math.hypot(x, y, z)
  return l > 0 ? [x / l, y / l, z / l] : members[0].dir
}

function farthestFrom(members, centre) {
  let worst = members[0], worstDot = dot(worst.dir, centre)
  for (let i = 1; i < members.length; i++) {
    const d = dot(members[i].dir, centre)
    if (d < worstDot) { worst = members[i]; worstDot = d }
  }
  return { member: worst, dot: worstDot }
}

export function createClusterAssigner({ radius, linkM, memberRadiusM, lattice = null, hysteresisDeg = CHART_REANCHOR_HYSTERESIS_DEG, stayFactor = CLUSTER_STAY_FACTOR, joinFactor = CLUSTER_JOIN_FACTOR }) {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error(`cluster assigner needs a positive finite planet radius, got ${radius}`)
  if (!(linkM > 0) || !(memberRadiusM > 0)) throw new Error(`cluster assigner needs positive linkM and memberRadiusM, got ${linkM} and ${memberRadiusM}`)
  if (!(joinFactor < 1 && stayFactor > 1)) throw new Error(`cluster hysteresis needs joinFactor < 1 < stayFactor, got ${joinFactor} and ${stayFactor}`)
  const cosOf = m => Math.cos(Math.min(Math.PI, m / radius))
  const cosLink = cosOf(linkM), cosJoin = cosOf(memberRadiusM * joinFactor), cosStay = cosOf(memberRadiusM * stayFactor)
  const state = { nextClusterId: 1, clusterOf: new Map(), anchors: new Map() }

  function admit(players) {
    const accepted = [], rejected = [], seen = new Set()
    for (const p of players) {
      const dir = unitDir(p.dir)
      if (!dir) { rejected.push({ id: p.id, reason: 'direction-is-not-a-finite-nonzero-3-vector' }); continue }
      if (seen.has(p.id)) { rejected.push({ id: p.id, reason: 'duplicate-player-id' }); continue }
      seen.add(p.id)
      accepted.push({ id: p.id, dir })
    }
    accepted.sort((a, b) => byId(a.id, b.id))
    return { accepted, rejected }
  }

  function retainPreviousClusters(accepted) {
    const groups = new Map(), pool = []
    for (const m of accepted) {
      const k = state.clusterOf.get(m.id)
      if (k === undefined) { pool.push(m); continue }
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(m)
    }
    const clusters = new Map()
    for (const k of [...groups.keys()].sort((a, b) => a - b)) {
      const members = groups.get(k)
      let centre = centroidOf(members)
      while (members.length > 1) {
        const far = farthestFrom(members, centre)
        if (far.dot >= cosStay) break
        members.splice(members.indexOf(far.member), 1)
        pool.push(far.member)
        centre = centroidOf(members)
      }
      clusters.set(k, { id: k, members, centre })
    }
    pool.sort((a, b) => byId(a.id, b.id))
    return { clusters, pool }
  }

  function attachToExisting(clusters, pool) {
    const left = []
    const joins = new Map()
    for (const m of pool) {
      let best = null, bestDot = -2
      for (const c of clusters.values()) {
        const d = dot(m.dir, c.centre)
        if (d >= cosJoin && (d > bestDot || (d === bestDot && c.id < best.id))) { best = c; bestDot = d }
      }
      if (best) { if (!joins.has(best.id)) joins.set(best.id, []); joins.get(best.id).push(m) } else left.push(m)
    }
    for (const [k, added] of joins) {
      const c = clusters.get(k)
      c.members.push(...added)
      c.members.sort((a, b) => byId(a.id, b.id))
      c.centre = centroidOf(c.members)
    }
    return left
  }

  function linkedComponents(left) {
    const parent = left.map((_, i) => i)
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
    for (let i = 0; i < left.length; i++) {
      for (let j = i + 1; j < left.length; j++) {
        const sameBefore = state.clusterOf.has(left[i].id) && state.clusterOf.get(left[i].id) === state.clusterOf.get(left[j].id)
        const need = sameBefore ? cosOf(linkM * stayFactor) : cosLink
        if (dot(left[i].dir, left[j].dir) >= need) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b) }
      }
    }
    const comps = new Map()
    left.forEach((m, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(m) })
    return [...comps.values()].sort((a, b) => byId(a[0].id, b[0].id))
  }

  function packComponent(component, clusters) {
    let remaining = component
    while (remaining.length) {
      const centre = centroidOf(remaining)
      let inside = remaining.filter(m => dot(m.dir, centre) >= cosJoin)
      if (!inside.length) {
        let nearest = remaining[0]
        for (const m of remaining) if (dot(m.dir, centre) > dot(nearest.dir, centre)) nearest = m
        inside = [nearest]
      }
      const id = state.nextClusterId++
      clusters.set(id, { id, members: inside, centre: centroidOf(inside), created: true })
      const taken = new Set(inside)
      remaining = remaining.filter(m => !taken.has(m))
    }
  }

  function mergeConverged(clusters, events) {
    let merged = true
    while (merged) {
      merged = false
      const ids = [...clusters.keys()].sort((a, b) => a - b)
      for (let i = 0; i < ids.length && !merged; i++) {
        for (let j = i + 1; j < ids.length && !merged; j++) {
          const a = clusters.get(ids[i]), b = clusters.get(ids[j])
          if (dot(a.centre, b.centre) < cosOf(2 * memberRadiusM * stayFactor + linkM)) continue
          let linked = false
          for (const ma of a.members) { for (const mb of b.members) if (dot(ma.dir, mb.dir) >= cosLink) { linked = true; break } if (linked) break }
          if (!linked) continue
          const all = a.members.concat(b.members)
          const centre = centroidOf(all)
          if (farthestFrom(all, centre).dot < cosJoin) continue
          const survivor = (a.members.length > b.members.length || (a.members.length === b.members.length && a.id < b.id)) ? a : b
          const gone = survivor === a ? b : a
          survivor.members = all.sort((x, y) => byId(x.id, y.id))
          survivor.centre = centre
          clusters.delete(gone.id)
          events.push({ type: 'merge', into: survivor.id, from: gone.id })
          merged = true
        }
      }
    }
  }

  function anchorFor(cluster) {
    if (!lattice) return null
    const prev = state.anchors.get(cluster.id)
    if (!prev) return chartAnchorForDir(lattice, cluster.centre)
    const decision = chartAnchorDecision({ lattice, frame: { up: prev }, dirs: cluster.members.map(m => m.dir), hysteresisDeg })
    return decision && !decision.refusal ? decision.anchorDir : prev
  }

  function assign(players) {
    const { accepted, rejected } = admit(players)
    const events = []
    const { clusters, pool } = retainPreviousClusters(accepted)
    const left = attachToExisting(clusters, pool)
    for (const component of linkedComponents(left)) packComponent(component, clusters)
    mergeConverged(clusters, events)

    const clusterOf = new Map(), anchors = new Map(), out = []
    for (const id of [...clusters.keys()].sort((a, b) => a - b)) {
      const c = clusters.get(id)
      for (const m of c.members) {
        clusterOf.set(m.id, id)
        const before = state.clusterOf.get(m.id)
        if (before !== undefined && before !== id) events.push({ type: 'handoff', playerId: m.id, from: before, to: id })
      }
      const anchorDir = anchorFor(c)
      if (anchorDir) anchors.set(id, anchorDir)
      out.push({ id, memberIds: c.members.map(m => m.id), centroidDir: c.centre, radiusM: radius * Math.acos(Math.max(-1, Math.min(1, farthestFrom(c.members, c.centre).dot))), anchorDir, created: c.created === true })
    }
    const mergedAway = new Set(events.filter(e => e.type === 'merge').map(e => e.from))
    for (const k of new Set(state.clusterOf.values())) if (!clusters.has(k) && !mergedAway.has(k)) events.push({ type: 'drop', cluster: k })
    state.clusterOf = clusterOf
    state.anchors = anchors
    return { clusters: out, clusterOf, rejected, events }
  }

  return { assign, state }
}
