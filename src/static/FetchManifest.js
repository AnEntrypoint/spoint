import { existsSync, statSync } from 'node:fs'
import { resolve, sep, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getTransformedAsync } from './GLBTransformer.js'
import { getKtx2Extracted } from './KTX2Extract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _streamingSchedulerCandidates = [
  join(__dirname, '../../client/core/StreamingScheduler.js'),
  join(__dirname, '../../core/StreamingScheduler.js'),
]
let _scoreRequestPromise = null
function _loadScoreRequest() {
  if (!_scoreRequestPromise) {
    const fp = _streamingSchedulerCandidates.find(existsSync)
    if (!fp) return Promise.reject(new Error('FetchManifest: could not locate client/core/StreamingScheduler.js in any known layout (tried: ' + _streamingSchedulerCandidates.join(', ') + ')'))
    _scoreRequestPromise = import(pathToFileURL(fp).href).then(m => m.scoreRequest)
  }
  return _scoreRequestPromise
}

const _manifestCache = new Map()
const TEXTURE_MIP_SCORE_MUL = 1.05

function resolveModelPaths(model, project, sdkRoot) {
  const rel = model.startsWith('./') ? model.slice(2) : model.startsWith('/') ? model.slice(1) : model
  for (const dir of [project, sdkRoot]) {
    const fp = resolve(dir, rel)
    if (existsSync(fp)) return { fp, url: '/' + rel.split(sep).join('/') }
  }
  return null
}

function _entityDistance(entity, spawn) {
  const p = entity.position
  if (!Array.isArray(p) || p.length < 3) return 0
  const sp = Array.isArray(spawn) && spawn.length >= 3 ? spawn : [0, 0, 0]
  const dx = p[0] - sp[0], dy = p[1] - sp[1], dz = p[2] - sp[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export async function buildManifestEntries(worldDef, project, sdkRoot) {
  const scoreRequest = await _loadScoreRequest()
  const entities = Array.isArray(worldDef.entities) ? worldDef.entities : []
  const spawn = worldDef.worldSpawnPoint || worldDef.player?.spawn || [0, 0, 0]
  const entries = []
  const seenModel = new Set()
  for (const entity of entities) {
    if (!entity.model || typeof entity.model !== 'string') continue
    if (seenModel.has(entity.model)) continue
    seenModel.add(entity.model)
    const resolved = resolveModelPaths(entity.model, project, sdkRoot)
    if (!resolved) continue
    const { fp, url } = resolved
    let stat
    try { stat = statSync(fp) } catch { continue }
    const features = {
      distance: _entityDistance(entity, spawn),
      inFrustum: true,
      gameplayBoost: Number.isFinite(entity.custom?._preloadBoost) ? entity.custom._preloadBoost : 0,
    }
    const score = scoreRequest(features)
    let byteSize = stat.size
    try {
      const transformed = await getTransformedAsync(fp)
      if (transformed) byteSize = transformed.length
    } catch { }
    entries.push({ url, kind: 'model', score, byteSize, entityId: entity.id || null })

    try {
      const ktx2Ready = getKtx2Extracted(fp)
      if (ktx2Ready) {
        for (const idx of ktx2Ready.indices) {
          entries.push({
            url: `${url}.ktx2/${idx}.ktx2`,
            kind: 'textureMip',
            score: score * TEXTURE_MIP_SCORE_MUL,
            byteSize: null,
            entityId: entity.id || null,
          })
        }
      }
    } catch { }
  }
  return entries
}

export async function buildFetchManifest(worldName, worldDef, project, sdkRoot) {
  const entities = Array.isArray(worldDef.entities) ? worldDef.entities : []
  let mtimeKey = ''
  for (const e of entities) {
    if (!e.model) continue
    const resolved = resolveModelPaths(e.model, project, sdkRoot)
    if (!resolved) continue
    try { mtimeKey += `${e.model}:${statSync(resolved.fp).mtimeMs};` } catch {}
    try { const ready = getKtx2Extracted(resolved.fp); mtimeKey += `ktx2:${ready ? ready.indices.length : 0};` } catch {}
  }
  const cached = _manifestCache.get(worldName)
  if (cached && cached.mtimeKey === mtimeKey) return cached.manifest
  const entries = await buildManifestEntries(worldDef, project, sdkRoot)
  entries.sort((a, b) => a.score - b.score)
  const manifest = { worldName, generatedAt: Date.now(), entries }
  _manifestCache.set(worldName, { mtimeKey, manifest })
  return manifest
}

export function clearManifestCache(worldName) {
  if (worldName) _manifestCache.delete(worldName)
  else _manifestCache.clear()
}
