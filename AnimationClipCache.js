import * as THREE from 'three'
import { get, put, remove } from './IndexedDBStore.js'

const DB_NAME = 'spawnpoint-anim-cache'
const DB_VERSION = 3
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

function serializeClip(clip) {
  const tracks = []
  for (const track of clip.tracks) {
    const type = getTrackTypeName(track)
    if (!type) continue
    tracks.push({ name: track.name, type, times: track.times.buffer.slice(track.times.byteOffset, track.times.byteOffset + track.times.byteLength), values: track.values.buffer.slice(track.values.byteOffset, track.values.byteOffset + track.values.byteLength), interpolation: track.getInterpolation?.() ?? 2301 })
  }
  return { name: clip.name, duration: clip.duration, tracks }
}

function deserializeClip(data) {
  const typeMap = Object.fromEntries(TRACK_TYPES)
  const tracks = data.tracks.map(t => {
    const TrackClass = typeMap[t.type]
    if (!TrackClass) throw new Error(`Unknown track type: ${t.type}`)
    const times = t.times instanceof ArrayBuffer ? new Float32Array(t.times) : new Float32Array(t.times)
    const values = t.values instanceof ArrayBuffer ? new Float32Array(t.values) : new Float32Array(t.values)
    const track = new TrackClass(t.name, times, values)
    if (t.interpolation !== undefined && track.setInterpolation) track.setInterpolation(t.interpolation)
    return track
  })
  return new THREE.AnimationClip(data.name, data.duration, tracks)
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
