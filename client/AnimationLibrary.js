import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getCachedClips, cacheClips, hasCachedClips, warmClipStore } from './AnimationClipCache.js'

const q1 = new THREE.Quaternion()
const restInv = new THREE.Quaternion()
const parentRest = new THREE.Quaternion()

function normalizeClips(gltf, vrmVersion, vrmHumanoid) {
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const clips = new Map()
  for (const clip of gltf.animations) {
    const name = clip.name.replace(/^VRM\|/, '').replace(/@\d+$/, '')
    const tracks = []
    for (const track of clip.tracks) {
      const [boneName, property] = track.name.split('.')
      if (property === 'scale') continue
      if (property === 'position') {
        if (boneName !== 'root' && boneName !== 'hips') continue
        if (vrmVersion === '0') {
          const newTrack = track.clone()
          for (let i = 0; i < newTrack.values.length; i += 3) {
            newTrack.values[i] = -newTrack.values[i]
            newTrack.values[i + 2] = -newTrack.values[i + 2]
          }
          tracks.push(newTrack)
        } else {
          tracks.push(track)
        }
        continue
      }
      let bone = scene.getObjectByName(boneName)
      if (!bone && vrmHumanoid) bone = vrmHumanoid.getNormalizedBoneNode(boneName)
      if (!bone || !bone.parent) { tracks.push(track); continue }
      if (property === 'quaternion') {
        bone.getWorldQuaternion(restInv).invert()
        bone.parent.getWorldQuaternion(parentRest)
        const newTrack = track.clone()
        for (let i = 0; i < newTrack.values.length; i += 4) {
          q1.fromArray(newTrack.values, i)
          q1.premultiply(parentRest).multiply(restInv)
          if (vrmVersion === '0') { q1.x = -q1.x; q1.z = -q1.z }
          q1.toArray(newTrack.values, i)
        }
        tracks.push(newTrack)
      } else {
        tracks.push(track)
      }
    }
    clips.set(name, new THREE.AnimationClip(clip.name, clip.duration, tracks))
  }
  return clips
}

let _gltfPromise = null
let _normalizedCache = null
let _srcTagPromise = null

export function preloadAnimationLibrary(loader) {
  if (_gltfPromise) return _gltfPromise
  const l = loader || new GLTFLoader()
  _gltfPromise = l.loadAsync('/anim-lib.glb')
  return _gltfPromise
}

// Conditional boot-time preload: loadAnimationLibrary() below returns straight from the IndexedDB
// clip cache on a warm client without ever touching the GLB, so an unconditional preload downloaded
// AND GLTFLoader-parsed the 6.9MB /anim-lib.glb on every warm boot for nothing (live-counted). This
// probes the cache first -- same HEAD-derived srcTag key loadAnimationLibrary uses (shared
// _srcTagPromise, so the HEAD is issued exactly once either way) for both VRM-version key variants
// (the version isn't known until the player VRM's JSON is read, later) -- and only kicks the real
// preload on a miss. Cold path (no cache): HEAD + two sub-ms IDB lookups, then the identical
// preloadAnimationLibrary() call as before, so the cold download still overlaps the world import +
// worker boot exactly as it did. Idempotent and cached like preloadAnimationLibrary itself.
let _conditionalPreload = null
export function preloadAnimationLibraryIfUncached(loader) {
  if (_conditionalPreload) return _conditionalPreload
  if (_gltfPromise) return (_conditionalPreload = _gltfPromise.then(() => true))
  _conditionalPreload = (async () => {
    let hit = false
    try {
      const [srcTag] = await Promise.all([_fetchSrcTag(), warmClipStore()])
      const [v1, v0] = await Promise.all([hasCachedClips(`anim-lib-v1-${srcTag}`), hasCachedClips(`anim-lib-v0-${srcTag}`)])
      hit = v1 || v0
    } catch (_) { hit = false }
    if (hit) return false
    preloadAnimationLibrary(loader)
    return true
  })()
  return _conditionalPreload
}

// The server stamps a content-derived ETag on /anim-lib.glb (StaticHandler.js, keyed off the source
// file's mtime). Folding it into the IndexedDB cache key means a changed source (new mtime -> new
// ETag, e.g. the file being swapped/updated) naturally invalidates every previously-cached client --
// without this, a stale IndexedDB entry from a bone-naming-incompatible/older anim-lib.glb never
// expires on its own (witnessed: 57 VRM-named clips served from a stale disk transform cache stayed
// live in a browser's IndexedDB after the source GLB was updated to a 109-clip Mixamo-named rig;
// filterValidClipTracks then silently drops every track whose bone name doesn't match the current
// skeleton, leaving a "valid" zero-track AnimationAction -- state machine transitions correctly,
// mixer.update() runs every frame, but nothing moves).
function _fetchSrcTag() {
  if (_srcTagPromise) return _srcTagPromise
  _srcTagPromise = fetch('/anim-lib.glb', { method: 'HEAD' })
    .then(r => r.headers.get('etag') || r.headers.get('last-modified') || 'unknown')
    .catch(() => 'unknown')
  return _srcTagPromise
}

export async function loadAnimationLibrary(vrmVersion, vrmHumanoid) {
  if (_normalizedCache) return _normalizedCache
  // Open the IndexedDB store while the HEAD is in flight (both are independent I/O) instead of
  // serially: HEAD -> open DB -> get. warmClipStore is memoized inside IndexedDBStore.openStore, so
  // getCachedClips below reuses the same open handle.
  const [srcTag] = await Promise.all([_fetchSrcTag(), warmClipStore()])
  const cacheKey = `anim-lib-v${vrmVersion || '1'}-${srcTag}`
  const cached = await getCachedClips(cacheKey)
  if (cached) {
    console.log(`[anim] Loaded ${cached.size} clips from cache`)
    _normalizedCache = { normalizedClips: cached, rawClips: cached }
    return _normalizedCache
  }
  const gltf = await preloadAnimationLibrary()
  if (_normalizedCache) return _normalizedCache
  const normalizedClips = normalizeClips(gltf, vrmVersion || '1', vrmHumanoid)
  _gltfPromise = null
  console.log(`[anim] Loaded animation library (${normalizedClips.size} clips):`, [...normalizedClips.keys()])
  _normalizedCache = { normalizedClips, rawClips: normalizedClips }
  // Fire-and-forget: the serialize+quantize bake and the IndexedDB write only benefit the NEXT boot;
  // nothing in this session reads the store again (the in-memory _normalizedCache is authoritative),
  // so ASSETS_DONE no longer waits on it. cacheClips already swallows its own failures.
  cacheClips(cacheKey, normalizedClips).catch(() => {})
  return _normalizedCache
}
