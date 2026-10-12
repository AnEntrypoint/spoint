import * as THREE from 'three/webgpu'
import { float, uniform, texture, clamp, mix, step, varying, positionLocal } from 'three/tsl'

const FIELD_SIZE = 512
const FIELD_WINDOW_M = 512

const fieldTexture = new THREE.DataTexture(
  new Uint8Array(FIELD_SIZE * FIELD_SIZE).fill(255), FIELD_SIZE, FIELD_SIZE, THREE.RedFormat, THREE.UnsignedByteType,
)
fieldTexture.minFilter = THREE.LinearFilter
fieldTexture.magFilter = THREE.LinearFilter
fieldTexture.generateMipmaps = false
fieldTexture.wrapS = THREE.ClampToEdgeWrapping
fieldTexture.wrapT = THREE.ClampToEdgeWrapping
fieldTexture.needsUpdate = true

const uActive = uniform(0)
const uOrigin = uniform(new THREE.Vector2())
const uInvWindow = uniform(1 / FIELD_WINDOW_M)

export function contactOcclusionFactorAt(xz) {
  const uv = xz.sub(uOrigin).mul(uInvWindow)
  const inside = step(0.0, uv.x).mul(step(uv.x, 1.0)).mul(step(0.0, uv.y)).mul(step(uv.y, 1.0)).mul(uActive)
  const darkening = texture(fieldTexture, clamp(uv, 0.0, 1.0)).r
  return mix(float(1.0), darkening, inside)
}

export function contactOcclusionFactor() {
  return contactOcclusionFactorAt(varying(positionLocal.xz, 'vContactSceneXZ'))
}

export function syncContactOcclusion(field) {
  if (field.size !== FIELD_SIZE) throw new Error(`contact occlusion field size ${field.size} != ${FIELD_SIZE}`)
  uActive.value = 1
  uOrigin.value.set(field.originX, field.originZ)
  if (!field.dirty) return false
  fieldTexture.image = { data: field.data, width: FIELD_SIZE, height: FIELD_SIZE }
  fieldTexture.needsUpdate = true
  field.dirty = false
  return true
}
