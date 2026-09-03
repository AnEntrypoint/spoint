import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getCachedClips, cacheClips } from './AnimationClipCache.js'

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
  const srcTag = await _fetchSrcTag()
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
  await cacheClips(cacheKey, normalizedClips)
  return _normalizedCache
}
