import { ModelPool } from 'streaming-gltf/model-pool'
import * as THREE from 'three'
import { applyUnderwaterTintNode } from './core/UnderwaterTintTSL.js'
import { applyWetnessTintNode } from './core/WetnessTintTSL.js'

const _debugBox = new THREE.Box3()
const _debugSize = new THREE.Vector3()
const _debugCenter = new THREE.Vector3()
const BOOT_BANDWIDTH_FRIENDLY_WORKER_COUNT = 2
const COMPILE_HIDE_FAILSAFE_MS = 8000

export function progressiveUrl(modelUrl) {
  return modelUrl + '.prog/model.progressive.glb'
}

function _disableClusterCull(root) {
  if (!root || typeof root.traverse !== 'function') return
  root.traverse(o => {
    if (!o || !o.clusterSet || !o.clusterSet.clusters || o._spointCullDisabled) return
    o._spointNoClusterCull = true
    o._spointCullDisabled = true
  })
}

function _tintComposeForWebGPU(material) {
  applyUnderwaterTintNode(material)
  applyWetnessTintNode(material)
}

export function createModelPool(scene, renderer, camera, { vramBudgetMB, deviceInfo } = {}) {
  const tintCompose = (renderer && renderer.isWebGPURenderer) ? _tintComposeForWebGPU : undefined
  const pool = new ModelPool({ scene, renderer, camera, useGlobalMaterialPool: false, workerCount: BOOT_BANDWIDTH_FRIENDLY_WORKER_COUNT, useOcclusionQuery: true, occlusionMinCandidates: 32, useImpostorFinalLod: true, impostorPx: 14, impostorTextureSize: 1024, impostorMaxAssets: 64, useBatchedFarTier: true, useMaterialBucketBatching: true, textureArrayAtlas: true, vramBudgetMB, deviceInfo, tintCompose })
  try { pool.ceilingLod = null } catch (_) {}

  const VRAM_LOG_CAP = 40
  const _vramLog = []
  function _logVramEvent(type, payload) {
    _vramLog.push({ type, t: Date.now(), ...payload })
    if (_vramLog.length > VRAM_LOG_CAP) _vramLog.shift()
  }
  if (pool.on) {
    pool.on('vram-warning', (p) => _logVramEvent('vram-warning', p))
    pool.on('vram-critical', (p) => _logVramEvent('vram-critical', p))
    pool.on('budget-pressure', (p) => _logVramEvent('budget-pressure', p))
    pool.on('budget-relaxed', (p) => _logVramEvent('budget-relaxed', p))
    pool.on('budget-adjust', (p) => { if (p && p.reason === 'over-budget') _logVramEvent('budget-adjust', p) })
  }
  function getVramLog() { return _vramLog.slice() }

  function setVramBudgetMB(mb) { return pool.setVramBudgetMB ? pool.setVramBudgetMB(mb) : null }

  const _entities = new Map()
  const _progReady = new Map()

  async function progressiveReady(modelUrl) {
    if (_progReady.has(modelUrl)) return _progReady.get(modelUrl)
    let ready = false
    const url = progressiveUrl(modelUrl)
    try {
      let r = await fetch(url, { method: 'HEAD' })
      if ((r.status === 405 || r.status === 501)) r = await fetch(url, { method: 'GET' })
      if (r.status >= 500) r = await fetch(url, { method: 'HEAD' })
      ready = r.ok
    } catch (_) { ready = false }
    if (ready) _progReady.set(modelUrl, true)
    return ready
  }

  function _spawnPooled(entityId, handle, { position, rotation, scale } = {}, onReady, { readyHook, readyArg2 } = {}) {
    const applyTransform = (root) => {
      if (!root) return
      if (position) root.position.fromArray(position)
      if (rotation) root.quaternion.fromArray(rotation)
      if (scale) root.scale.fromArray(scale)
    }
    applyTransform(handle.root)
    if (handle.root && handle.root.parent !== scene) scene.add(handle.root)
    _hideUntilCompiled(handle)
    _entities.set(entityId, { handle, root: handle.root })
    handle.on('ready', (e) => {
      const r = _entities.get(entityId)
      if (r) r.root = handle.root
      applyTransform(handle.root)
      if (handle.root && handle.root.parent !== scene) scene.add(handle.root)
      if (readyHook) readyHook(handle.root)
      if (onReady) onReady(handle.root, readyArg2 ? readyArg2(handle, e) : e)
    })
    return _entities.get(entityId)
  }

  function spawn(entityId, modelUrl, transform = {}, onReady) {
    const handle = pool.spawn(progressiveUrl(modelUrl), {})
    return _spawnPooled(entityId, handle, transform, onReady, { readyHook: _disableClusterCull })
  }

  function _hideUntilCompiled(handle) {
    const r0 = handle.root
    if (!r0) return
    r0.visible = false
    r0.userData._compileHidden = true
    setTimeout(() => {
      for (const r of [r0, handle.root]) {
        if (r && r.userData._compileHidden) { r.userData._compileHidden = false; r.visible = true }
      }
    }, COMPILE_HIDE_FAILSAFE_MS)
  }

  function spawnVRM(entityId, vrmUrl, transform = {}, onReady) {
    const handle = pool.spawn(vrmUrl, { driveVrm: false })
    return _spawnPooled(entityId, handle, transform, onReady, { readyArg2: (h) => h.actualEntity })
  }

  function remove(entityId) {
    const rec = _entities.get(entityId)
    if (!rec) return
    try { rec.handle?.dispose() } catch (_) {}
    _entities.delete(entityId)
  }

  function setTarget(entityId, x, y, z, durationMs = 300) {
    const rec = _entities.get(entityId)
    const ent = rec?.handle?.actualEntity
    if (ent) pool.setTarget(ent, x, y, z, durationMs)
  }

  function setRotation(entityId, qx, qy, qz, qw) {
    if (!(Number.isFinite(qx) && Number.isFinite(qy) && Number.isFinite(qz) && Number.isFinite(qw))) return
    const rec = _entities.get(entityId)
    const ent = rec?.handle?.actualEntity
    if (ent && pool.setRotation) pool.setRotation(ent, qx, qy, qz, qw)
  }

  function update() { pool.update() }
  function runOcclusionQueries() { pool.runOcclusionQueries?.() }

  function setOcclusionQueryBudget(n) {
    if (!Number.isFinite(n) || n < 0) return
    const tier = pool._occlusionTier
    if (tier) tier.maxQueriesPerFrame = n
  }
  function getOcclusionQueryBudget() {
    const tier = pool._occlusionTier
    return tier ? tier.maxQueriesPerFrame : null
  }

  function getStats() {
    const raw = pool.getStats?.() || {}
    const occ = raw.occlusion || {}
    const candidateCount = Array.isArray(pool._occlusionCandidates) ? pool._occlusionCandidates.length : 0
    const tier = pool._occlusionTier
    const pendingCount = tier && tier._records ? tier._records.size : 0
    return {
      ...raw,
      candidates: candidateCount,
      queriedThisFrame: occ.queried || 0,
      resolved: occ.resolved || 0,
      occluded: occ.occluded || 0,
      failOpens: 0,
      anomalyTrips: 0,
      flips: 0,
      oldestPendingFrames: pendingCount > 0 ? 1 : 0,
    }
  }
  function getCandidateCount() { return Array.isArray(pool._occlusionCandidates) ? pool._occlusionCandidates.length : 0 }
  function has(entityId) { return _entities.has(entityId) }

  function getVramStats() {
    const raw = pool.getStats?.() || {}
    const vram = raw.vram || {}
    const um = raw.unloadManager || {}
    return {
      usedMB: vram.usedMB ?? 0,
      estimatedVramMB: vram.estimatedVramMB ?? 0,
      currentRatio: vram.currentRatio ?? 0,
      peakRatio: vram.peakRatio ?? 0,
      byteBudgetMB: pool.byteBudget != null ? pool.byteBudget / (1024 * 1024) : null,
      totalBytes: pool._totalBytes ?? 0,
      unloadedCount: um.unloadedCount ?? 0,
      visibleEntities: um.visibleEntities ?? 0,
      invisibleEntities: um.invisibleEntities ?? 0,
      recentEvents: getVramLog(),
    }
  }

  function getDebugBoxes() {
    const out = []
    const candidates = pool._occlusionCandidates
    const tier = pool._occlusionTier
    if (!Array.isArray(candidates) || !tier) return out
    for (const entity of candidates) {
      if (!entity || !entity.root) continue
      try {
        _debugBox.setFromObject(entity.root)
        if (_debugBox.isEmpty()) continue
        _debugBox.getSize(_debugSize)
        _debugBox.getCenter(_debugCenter)
        const state = tier.isOccluded(entity) ? 'occluded' : 'visible'
        out.push({ key: entity.id || entity.uuid || null, center: [_debugCenter.x, _debugCenter.y, _debugCenter.z], size: Math.max(_debugSize.x, _debugSize.y, _debugSize.z) * 0.5, state })
      } catch (_) {}
    }
    return out
  }

  return { pool, spawn, spawnVRM, remove, setTarget, setRotation, update, runOcclusionQueries, getStats, getCandidateCount, setOcclusionQueryBudget, getOcclusionQueryBudget, getDebugBoxes, has, progressiveReady, _entities, getVramStats, setVramBudgetMB, getVramLog }
}
