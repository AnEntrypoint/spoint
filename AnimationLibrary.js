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

export function preloadAnimationLibrary(loader) {
  if (_gltfPromise) return _gltfPromise
  const l = loader || new GLTFLoader()
  _gltfPromise = l.loadAsync('/spoint/anim-lib.glb')
  return _gltfPromise
}

export async function loadAnimationLibrary(vrmVersion, vrmHumanoid) {
  if (_normalizedCache) return _normalizedCache
  const cacheKey = `anim-lib-v${vrmVersion || '1'}`
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
