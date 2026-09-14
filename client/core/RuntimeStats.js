import { createElement } from 'webjsx'

const HISTORY_SIZE = 48

function createHistoryRing(size) {
  const ring = new Float64Array(size)
  let idx = 0, filled = 0, sum = 0
  return {
    push(v) {
      if (filled >= size) sum -= ring[idx]
      else filled++
      ring[idx] = v
      sum += v
      idx = (idx + 1) % size
    },
    get avg() { return filled ? sum / filled : 0 },
    get peak() {
      let peak = 0
      for (let i = 0; i < filled; i++) {
        const j = filled < size ? i : (idx + i) % size
        const v = ring[j]
        if (v > peak) peak = v
      }
      return peak
    },
    copyInOrder(out) {
      out.length = filled
      for (let i = 0; i < filled; i++) {
        const j = filled < size ? i : (idx + i) % size
        out[i] = ring[j]
      }
      return out
    }
  }
}

function sparkline(values, maxValue, className) {
  if (!values.length) return null
  return createElement('div', { class: `runtime-spark ${className || ''}` },
    ...values.map(v => {
      const h = Math.max(6, Math.min(100, (v / Math.max(1e-6, maxValue)) * 100))
      return createElement('span', { style: `height:${h}%` })
    })
  )
}

function fmt(n, d = 1) {
  if (!Number.isFinite(n)) return '-'
  return Number(n).toFixed(d)
}

export function createRuntimeStats() {
  const frameMsHistory = createHistoryRing(HISTORY_SIZE)
  const rttHistory = createHistoryRing(HISTORY_SIZE)
  const _frameMsOut = []
  const _rttOut = []
  let fps = 0
  let lastFrameTs = performance.now()
  let fpsFrames = 0
  let fpsWindowStart = performance.now()

  function onFrame(now) {
    const dt = Math.max(0.001, (now - lastFrameTs) / 1000)
    lastFrameTs = now
    frameMsHistory.push(dt * 1000)
    fpsFrames++
    if (now - fpsWindowStart >= 1000) {
      fps = fpsFrames
      fpsFrames = 0
      fpsWindowStart = now
    }
  }

  function snapshot(client, renderer, pm, el) {
    const rtt = client?.getRTT ? client.getRTT() : 0
    rttHistory.push(Math.max(0, rtt || 0))
    const info = renderer?.info?.render || { calls: 0, triangles: 0 }
    return {
      fps,
      frameMsAvg: frameMsHistory.avg,
      frameMsPeak: frameMsHistory.peak,
      drawCalls: info.calls || 0,
      tris: info.triangles || 0,
      players: pm?.playerMeshes?.size || 0,
      entities: el?.entityMeshes?.size || 0,
      tick: client?.currentTick || 0,
      rtt: rtt || 0,
      buffer: client?.getBufferHealth ? client.getBufferHealth() : '-',
      frameMsHistory: frameMsHistory.copyInOrder(_frameMsOut),
      rttHistory: rttHistory.copyInOrder(_rttOut),
      culling: (typeof window !== 'undefined' && window.__culling && window.__culling.aggregate) ? window.__culling.aggregate() : null
    }
  }

  function renderPanel(s) {
    if (!s) return null
    const rows = [
      createElement('div', { class: 'runtime-title' }, 'RUNTIME'),
      createElement('div', { class: 'runtime-row' }, `FPS ${Math.round(s.fps)}  |  ${fmt(s.frameMsAvg, 2)}ms avg  |  ${fmt(s.frameMsPeak, 2)}ms peak`),
      sparkline(s.frameMsHistory, Math.max(25, s.frameMsPeak * 1.2), 'runtime-spark-frame'),
      createElement('div', { class: 'runtime-row' }, `DRAW ${s.drawCalls}  |  TRIS ${s.tris}`),
      createElement('div', { class: 'runtime-row' }, `PLAYERS ${s.players}  |  ENTITIES ${s.entities}  |  TICK ${s.tick}`),
      createElement('div', { class: 'runtime-row' }, `RTT ${fmt(s.rtt, 0)}ms  |  BUF ${s.buffer}`),
      sparkline(s.rttHistory, Math.max(60, ...s.rttHistory, 1), 'runtime-spark-rtt')
    ]
    if (s.culling && s.culling.totals) {
      const c = s.culling.totals
      rows.push(createElement('div', { class: 'runtime-row' }, `CULL ${c.occluded || 0}/${c.candidates || 0}  |  FAILOPEN ${c.failOpens || 0}  |  ANOMALY ${c.anomalyTrips || 0}`))
    }
    return createElement('div', { id: 'runtime-panel' }, ...rows)
  }

  return { onFrame, snapshot, renderPanel }
}

export function drawCallAudit(scene, renderer) {
  if (!scene || !renderer) return { error: 'scene-or-renderer-missing' }

  const info = renderer.info.render
  const mem = renderer.info.memory

  const materialUsage = new Map()
  const geometryUsage = new Map()
  const clusterMeshes = []
  let clusterLodMeshCount = 0, clusterLodTotalGroups = 0, clusterLodTotalClusters = 0
  let instancedMeshCount = 0, instancedTotalInstances = 0
  let plainMeshCount = 0

  scene.traverse((obj) => {
    const isInstanced = !!obj.isInstancedMesh || obj.type === 'InstancedMesh2' || obj.instancesCount !== undefined
    const isClusterLod = obj.constructor && obj.constructor.name === 'ClusterLodMesh'
    if (!obj.isMesh && !isInstanced) return

    if (isClusterLod) {
      clusterLodMeshCount++
      const groups = (obj.geometry && obj.geometry.groups) ? obj.geometry.groups.length : 0
      const clusters = (obj.clusterSet && obj.clusterSet.clusters) ? obj.clusterSet.clusters.length : 0
      clusterLodTotalGroups += groups
      clusterLodTotalClusters += clusters
      clusterMeshes.push({
        parentEntityId: obj.parentEntityId || obj.userData?.parentEntityId || null,
        name: obj.name || null,
        groups, clusters,
        visibleClusters: obj.stats ? obj.stats.visibleClusters : null,
        drawnTris: obj.stats ? obj.stats.drawnTris : null,
        totalTris: obj.stats ? obj.stats.totalTris : null
      })
    } else if (isInstanced) {
      instancedMeshCount++
      instancedTotalInstances += (obj.instancesCount || obj.count || 0)
    } else {
      plainMeshCount++
    }

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) {
      if (!m) continue
      let u = materialUsage.get(m.uuid)
      if (!u) { u = { type: m.type, name: m.name || '(unnamed)', transparent: !!m.transparent, meshCount: 0 }; materialUsage.set(m.uuid, u) }
      u.meshCount++
    }

    if (obj.geometry) geometryUsage.set(obj.geometry.uuid, (geometryUsage.get(obj.geometry.uuid) || 0) + 1)
  })

  const materialBreakdown = Array.from(materialUsage.values()).sort((a, b) => b.meshCount - a.meshCount)
  let geomUsedOnce = 0, geomUsedMultiple = 0, maxReuse = 0
  for (const c of geometryUsage.values()) {
    if (c === 1) geomUsedOnce++; else geomUsedMultiple++
    if (c > maxReuse) maxReuse = c
  }

  return {
    drawCalls: info.calls || 0,
    triangles: info.triangles || 0,
    geometriesLive: mem.geometries || 0,
    texturesLive: mem.textures || 0,
    clusterLodMeshCount, clusterLodTotalGroups, clusterLodTotalClusters,
    instancedMeshCount, instancedTotalInstances,
    plainMeshCount,
    materialBreakdown,
    geometryReuse: { distinctGeometries: geometryUsage.size, usedOnce: geomUsedOnce, usedMultiple: geomUsedMultiple, maxReuse },
    clusterMeshes
  }
}
