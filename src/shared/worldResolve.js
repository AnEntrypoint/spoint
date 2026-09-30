import { resolveNetcodeProfile } from '../netcode/NetcodeProfile.js'

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = v => typeof v === 'number' && Number.isFinite(v)
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum)
const PLAYER_POSITIVE_KEYS = ['capsuleRadius', 'capsuleHalfHeight', 'crouchHalfHeight', 'mass', 'health']

function reject(path, reason) { return { ok: false, path, reason } }

function checkSlices(w) {
  if (!isObj(w)) return reject('', 'world definition must be a plain object (the default export of the world module)')
  if (w.name !== undefined && typeof w.name !== 'string') return reject('name', 'must be a string')
  for (const k of ['tickRate', 'entityTickRate']) if (w[k] !== undefined && !(isNum(w[k]) && w[k] > 0 && w[k] <= 1000)) return reject(k, 'must be a finite number in (0, 1000]')
  for (const k of ['physicsRadius', 'physicsBodyBudget', 'relevanceRadius']) if (w[k] !== undefined && !(isNum(w[k]) && w[k] >= 0)) return reject(k, 'must be a non-negative finite number')
  if (w.gravity !== undefined && !isVec(w.gravity, 3)) return reject('gravity', 'must be [x, y, z] finite numbers')
  if (w.spawnPoint !== undefined && !isVec(w.spawnPoint, 3)) return reject('spawnPoint', 'must be [x, y, z] finite numbers')
  if (w.spawnPoints !== undefined) {
    if (!Array.isArray(w.spawnPoints)) return reject('spawnPoints', 'must be an array of [x, y, z]')
    const bad = w.spawnPoints.findIndex(p => !isVec(p, 3))
    if (bad >= 0) return reject(`spawnPoints[${bad}]`, 'must be [x, y, z] finite numbers')
  }
  if (w.player !== undefined) {
    if (!isObj(w.player)) return reject('player', 'must be an object')
    for (const k of PLAYER_POSITIVE_KEYS) if (w.player[k] !== undefined && !(isNum(w.player[k]) && w.player[k] > 0)) return reject(`player.${k}`, 'must be a positive finite number')
  }
  for (const k of ['movement', 'camera', 'animation', 'scene', 'input']) if (w[k] !== undefined && !isObj(w[k])) return reject(k, 'must be an object')
  if (w.terrain !== undefined && w.terrain !== null && typeof w.terrain !== 'boolean') {
    if (!isObj(w.terrain)) return reject('terrain', 'must be an object, a boolean or null')
    if (w.terrain.seed !== undefined && !isNum(w.terrain.seed)) return reject('terrain.seed', 'must be a finite number')
    if (w.terrain.radius !== undefined && !(isNum(w.terrain.radius) && w.terrain.radius > 0)) return reject('terrain.radius', 'must be a positive finite number')
    if (w.terrain.carves !== undefined && !Array.isArray(w.terrain.carves)) return reject('terrain.carves', 'must be an array')
  }
  if (w.iceServers !== undefined) {
    if (!Array.isArray(w.iceServers)) return reject('iceServers', 'must be an array of RTCIceServer objects')
    const bad = w.iceServers.findIndex(s => !isObj(s) || !(typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.every(u => typeof u === 'string'))))
    if (bad >= 0) return reject(`iceServers[${bad}].urls`, 'must be a string or an array of strings')
  }
  for (const k of ['placeableApps', 'trustedApps']) if (w[k] !== undefined && !(Array.isArray(w[k]) && w[k].every(a => typeof a === 'string'))) return reject(k, 'must be an array of app names')
  if (w.entities !== undefined) {
    if (!Array.isArray(w.entities)) return reject('entities', 'must be an array')
    const ids = new Set()
    for (let i = 0; i < w.entities.length; i++) {
      const e = w.entities[i]
      if (!isObj(e)) return reject(`entities[${i}]`, 'must be an object')
      if (e.id !== undefined) {
        if (typeof e.id !== 'string' || !e.id) return reject(`entities[${i}].id`, 'must be a non-empty string')
        if (ids.has(e.id)) return reject(`entities[${i}].id`, `duplicate entity id "${e.id}"`)
        ids.add(e.id)
      }
      if (e.app !== undefined && typeof e.app !== 'string') return reject(`entities[${i}].app`, 'must be an app name string')
      if (e.position !== undefined && !isVec(e.position, 3)) return reject(`entities[${i}].position`, 'must be [x, y, z] finite numbers')
      if (e.rotation !== undefined && !isVec(e.rotation, 4)) return reject(`entities[${i}].rotation`, 'must be a [x, y, z, w] quaternion of finite numbers')
      if (e.scale !== undefined && !isVec(e.scale, 3)) return reject(`entities[${i}].scale`, 'must be [x, y, z] finite numbers')
    }
  }
  try { resolveNetcodeProfile(w) } catch (e) { return reject('netcode', e.message) }
  return { ok: true, world: w }
}

export function parseWorld(worldDef) {
  return checkSlices(worldDef)
}

export function assertWorld(worldDef, worldName = null) {
  const r = parseWorld(worldDef)
  if (!r.ok) throw new TypeError(`[world] invalid world ${JSON.stringify(worldName ?? worldDef?.name ?? '(unnamed)')}: ${r.path || '(root)'} ${r.reason}`)
  return r.world
}
