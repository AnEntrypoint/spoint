import { MeshStandardNodeMaterial } from 'three/webgpu'
import { Fn, vec3, vec4, mix, clamp, fract, floor, float, positionLocal, varying, materialColor } from 'three/tsl'

const rkHash = Fn(([p]) => {
  const pv = p.toVar()
  pv.assign(fract(pv.mul(0.3183099).add(0.1)))
  pv.mulAssign(17.0)
  return fract(pv.x.mul(pv.y).mul(pv.z).mul(pv.x.add(pv.y).add(pv.z)))
})

const rkNoise = Fn(([x]) => {
  const i = floor(x)
  const f = fract(x).toVar()
  f.assign(f.mul(f).mul(float(3.0).sub(float(2.0).mul(f))))
  const nx0y0 = mix(rkHash(i.add(vec3(0.0, 0.0, 0.0))), rkHash(i.add(vec3(1.0, 0.0, 0.0))), f.x)
  const nx0y1 = mix(rkHash(i.add(vec3(0.0, 1.0, 0.0))), rkHash(i.add(vec3(1.0, 1.0, 0.0))), f.x)
  const nx1y0 = mix(rkHash(i.add(vec3(0.0, 0.0, 1.0))), rkHash(i.add(vec3(1.0, 0.0, 1.0))), f.x)
  const nx1y1 = mix(rkHash(i.add(vec3(0.0, 1.0, 1.0))), rkHash(i.add(vec3(1.0, 1.0, 1.0))), f.x)
  return mix(mix(nx0y0, nx0y1, f.y), mix(nx1y0, nx1y1, f.y), f.z)
})

export function applyRockTextureTSL(material) {
  material.flatShading = false
  const vLocalPos = varying(positionLocal, 'vLocalPos')
  const rkN = rkNoise(vLocalPos.mul(1.7)).mul(0.6)
    .add(rkNoise(vLocalPos.mul(6.5)).mul(0.3))
    .add(rkNoise(vLocalPos.mul(23.0)).mul(0.1))
  const rkLo = vec3(0.30, 0.28, 0.25)
  const rkHi = vec3(0.66, 0.62, 0.56)
  const tint = mix(rkLo, rkHi, clamp(rkN, 0.0, 1.0)).mul(2.05)
  material.colorNode = vec4(materialColor.rgb.mul(tint), materialColor.a)
  material.customProgramCacheKey = () => 'rockproc-batched-tsl'
  return material
}

export function makeRocksMaterialTSL() {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 })
  return applyRockTextureTSL(material)
}
