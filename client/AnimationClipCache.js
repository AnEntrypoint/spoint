import * as THREE from 'three'
import { get, put, remove } from './IndexedDBStore.js'

const DB_NAME = 'spawnpoint-anim-cache'
const DB_VERSION = 1
const STORE = 'clips'

function serializeClip(clip) {
  const tracks = clip.tracks.map(track => ({
    name: track.name,
    type: track.constructor.name,
    times: Array.from(track.times),
    values: Array.from(track.values),
    interpolation: track.getInterpolation?.() ?? 2301
  }))
  return { name: clip.name, duration: clip.duration, tracks }
}

function deserializeClip(data) {
  const tracks = data.tracks.map(t => {
    const TrackClass = THREE[t.type]
    if (!TrackClass) throw new Error(`Unknown track type: ${t.type}`)
    const track = new TrackClass(t.name, t.times, t.values)
    if (t.interpolation !== undefined && track.setInterpolation) {
      track.setInterpolation(t.interpolation)
    }
    return track
  })
  return new THREE.AnimationClip(data.name, data.duration, tracks)
}

export async function getCachedClips(cacheKey) {
  const cached = await get(DB_NAME, DB_VERSION, STORE, cacheKey)
  if (cached) {
    try {
      return new Map(cached.clips.map(c => [c.name, deserializeClip(c)]))
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
