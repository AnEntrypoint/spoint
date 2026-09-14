import * as THREE from 'three'
import { get, put, remove, openStore } from './IndexedDBStore.js'
import { packQuat, unpackQuat } from '../src/netcode/SnapshotEncoder.js'

const DB_NAME = 'spoint-anim-cache'
const DB_VERSION = 4
const STORE = 'clips'

const TRACK_TYPES = [
  ['QuaternionKeyframeTrack', THREE.QuaternionKeyframeTrack],
  ['VectorKeyframeTrack', THREE.VectorKeyframeTrack],
  ['NumberKeyframeTrack', THREE.NumberKeyframeTrack],
  ['BooleanKeyframeTrack', THREE.BooleanKeyframeTrack],
  ['StringKeyframeTrack', THREE.StringKeyframeTrack],
  ['ColorKeyframeTrack', THREE.ColorKeyframeTrack],
]

function getTrackTypeName(track) {
  for (const [name, cls] of TRACK_TYPES) {
    if (track instanceof cls) return name
  }
  return null
}

const RESAMPLE_HZ = 30
const POS_Q = 1000
const POS_I16_MAX = 32767 / POS_Q

function clampI16(v) { return Math.max(-32767, Math.min(32767, Math.round((v || 0) * POS_Q))) }

function resampleTimes(times, duration) {
  if (times.length < 2) return times
  const dt = 1 / RESAMPLE_HZ
  const count = Math.max(2, Math.round(duration / dt) + 1)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = Math.min(duration, i * dt)
  return out
}

function findBracket(times, t) {
  const n = times.length
  if (t <= times[0]) return [0, 0, 0]
  if (t >= times[n - 1]) return [n - 1, n - 1, 0]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid; else hi = mid
  }
  const span = times[hi] - times[lo]
  const alpha = span > 0 ? (t - times[lo]) / span : 0
  return [lo, hi, alpha]
}

function quantizeQuaternionTrack(track, resampledTimes) {
  const src = track.values
  const packed = new Uint32Array(resampledTimes.length)
  for (let i = 0; i < resampledTimes.length; i++) {
    const [i0, i1, alpha] = findBracket(track.times, resampledTimes[i])
    let rx, ry, rz, rw
    if (i0 === i1 || alpha === 0) {
      rx = src[i0 * 4]; ry = src[i0 * 4 + 1]; rz = src[i0 * 4 + 2]; rw = src[i0 * 4 + 3]
    } else {
      const q0x = src[i0*4], q0y = src[i0*4+1], q0z = src[i0*4+2], q0w = src[i0*4+3]
      let q1x = src[i1*4], q1y = src[i1*4+1], q1z = src[i1*4+2], q1w = src[i1*4+3]
      if (q0x*q1x + q0y*q1y + q0z*q1z + q0w*q1w < 0) { q1x = -q1x; q1y = -q1y; q1z = -q1z; q1w = -q1w }
      rx = q0x + (q1x - q0x) * alpha; ry = q0y + (q1y - q0y) * alpha
      rz = q0z + (q1z - q0z) * alpha; rw = q0w + (q1w - q0w) * alpha
      const len = Math.sqrt(rx*rx + ry*ry + rz*rz + rw*rw) || 1
      rx /= len; ry /= len; rz /= len; rw /= len
    }
    packed[i] = packQuat(rx, ry, rz, rw)
  }
  return packed
}

function quantizeVectorTrack(track, resampledTimes, itemSize) {
  const src = track.values
  const out = new Int16Array(resampledTimes.length * itemSize)
  for (let i = 0; i < resampledTimes.length; i++) {
    const [i0, i1, alpha] = findBracket(track.times, resampledTimes[i])
    for (let c = 0; c < itemSize; c++) {
      const v0 = src[i0 * itemSize + c], v1 = src[i1 * itemSize + c]
      const v = i0 === i1 ? v0 : v0 + (v1 - v0) * alpha
      out[i * itemSize + c] = clampI16(Math.max(-POS_I16_MAX, Math.min(POS_I16_MAX, v)))
    }
  }
  return out
}

const QUANTIZABLE = new Set(['QuaternionKeyframeTrack', 'VectorKeyframeTrack', 'NumberKeyframeTrack'])

function serializeClip(clip) {
  const tracks = []
  for (const track of clip.tracks) {
    const type = getTrackTypeName(track)
    if (!type) continue
    if (!QUANTIZABLE.has(type)) {
      tracks.push({ name: track.name, type, times: track.times.buffer.slice(track.times.byteOffset, track.times.byteOffset + track.times.byteLength), values: track.values.buffer.slice(track.values.byteOffset, track.values.byteOffset + track.values.byteLength), interpolation: track.getInterpolation?.() ?? 2301, q: false })
      continue
    }
    const resampledTimes = resampleTimes(track.times, clip.duration)
    let valuesBuf
    let itemSize = 0
    if (type === 'QuaternionKeyframeTrack') {
      valuesBuf = quantizeQuaternionTrack(track, resampledTimes).buffer
    } else {
      itemSize = track.values.length / track.times.length
      valuesBuf = quantizeVectorTrack(track, resampledTimes, itemSize).buffer
    }
    tracks.push({
      name: track.name, type, q: true, itemSize,
      t0: resampledTimes[0], dt: resampledTimes.length > 1 ? (resampledTimes[1] - resampledTimes[0]) : 0, count: resampledTimes.length,
      lastT: resampledTimes[resampledTimes.length - 1],
      values: valuesBuf,
      interpolation: track.getInterpolation?.() ?? 2301,
    })
  }
  return { name: clip.name, duration: clip.duration, tracks }
}

function dequantizeTimes(t) {
  const times = new Float32Array(t.count)
  for (let i = 0; i < t.count - 1; i++) times[i] = t.t0 + i * t.dt
  if (t.count > 0) times[t.count - 1] = t.lastT
  return times
}

function deserializeClip(data) {
  const typeMap = Object.fromEntries(TRACK_TYPES)
  const tracks = data.tracks.map(t => {
    const TrackClass = typeMap[t.type]
    if (!TrackClass) throw new Error(`Unknown track type: ${t.type}`)
    if (!t.q) {
      const times = new Float32Array(t.times)
      const values = new Float32Array(t.values)
      const track = new TrackClass(t.name, times, values)
      if (t.interpolation !== undefined && track.setInterpolation) track.setInterpolation(t.interpolation)
      return track
    }
    const times = dequantizeTimes(t)
    let values
    if (t.type === 'QuaternionKeyframeTrack') {
      const packed = new Uint32Array(t.values)
      values = new Float32Array(packed.length * 4)
      const out = [0, 0, 0, 0]
      for (let i = 0; i < packed.length; i++) { unpackQuat(packed[i], out); values[i*4]=out[0]; values[i*4+1]=out[1]; values[i*4+2]=out[2]; values[i*4+3]=out[3] }
    } else {
      const packed = new Int16Array(t.values)
      values = new Float32Array(packed.length)
      for (let i = 0; i < packed.length; i++) values[i] = packed[i] / POS_Q
    }
    const track = new TrackClass(t.name, times, values)
    if (t.interpolation !== undefined && track.setInterpolation) track.setInterpolation(t.interpolation)
    return track
  })
  return new THREE.AnimationClip(data.name, data.duration, tracks)
}

export function warmClipStore() {
  return openStore(DB_NAME, DB_VERSION, STORE).catch(() => null)
}

export async function hasCachedClips(cacheKey) {
  const cached = await get(DB_NAME, DB_VERSION, STORE, cacheKey)
  return !!(cached && Array.isArray(cached.clips) && cached.clips.length > 0)
}

export async function getCachedClips(cacheKey) {
  const cached = await get(DB_NAME, DB_VERSION, STORE, cacheKey)
  if (cached) {
    try {
      return new Map(cached.clips.map(c => [c.name.replace(/^VRM\|/, '').replace(/@\d+$/, ''), deserializeClip(c)]))
    } catch (e) {
      console.warn('[anim-cache] deserialize failed:', e.message)
      await remove(DB_NAME, DB_VERSION, STORE, cacheKey)
      return null
    }
  }
  return null
}

export async function cacheClips(cacheKey, clipsMap) {
  if (!clipsMap) return
  const clips = Array.from(clipsMap.values()).map(serializeClip)
  try {
    await put(DB_NAME, DB_VERSION, STORE, cacheKey, { clips, timestamp: Date.now() })
  } catch (e) {
    console.warn('[anim-cache] cache failed:', e.message)
  }
}
