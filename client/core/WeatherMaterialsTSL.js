import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn, Discard, vec2, vec3, vec4, float,
  uniform, attribute, varying, uv,
  positionLocal, positionView,
  clamp, mix, smoothstep, distance, abs, step, oneMinus,
} from 'three/tsl'
import { instanceMatrixNodeFor } from './WebGPUInstancing.js'

export function makeRainMaterialTSL() {
  const uColor = uniform(new THREE.Color(0.72, 0.78, 0.86))
  const uOpacity = uniform(0.6)

  const vFade = oneMinus(abs(uv().x.mul(2.0).sub(1.0)))
  const streak = smoothstep(0.0, 0.15, uv().y).mul(smoothstep(1.0, 0.85, uv().y))
  const a = uOpacity.mul(vFade).mul(float(0.3).add(streak.mul(0.7)))

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  material.colorNode = Fn(() => {
    Discard(a.lessThan(0.01))
    return vec4(uColor, a)
  })()
  material.customProgramCacheKey = () => 'weather-rain-streak-tsl'

  return { material, nodes: { uColor, uOpacity } }
}

export function makeSplashMaterialTSL() {
  const uTime = uniform(0)
  const uLifeS = uniform(0.4)
  const uColor = uniform(new THREE.Color(0.8, 0.85, 0.92))

  const spawnTime = attribute('spawnTime', 'float')
  const age = clamp(uTime.sub(spawnTime).div(uLifeS), 0.0, 1.0)
  const vAlpha = varying(oneMinus(age).mul(step(0.0, spawnTime)), 'vAlpha')

  const displacedPosition = Fn((builder) => {
    const instanceMatrixNode = instanceMatrixNodeFor(builder.object)
    const scale = mix(0.15, 1.0, age)
    const p = positionLocal.mul(scale)
    return instanceMatrixNode.mul(vec4(p, 1.0)).xyz
  })

  const d = distance(uv(), vec2(0.5, 0.5))
  const ring = smoothstep(0.5, 0.38, d).sub(smoothstep(0.38, 0.28, d))
  const a = ring.mul(vAlpha).mul(0.5)

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  material.positionNode = displacedPosition()
  material.colorNode = Fn(() => {
    Discard(a.lessThan(0.01))
    return vec4(uColor, a)
  })()
  material.customProgramCacheKey = () => 'weather-splash-ring-tsl'

  return { material, nodes: { uTime, uLifeS, uColor } }
}

export function makeSnowMaterialTSL() {
  const uColor = uniform(new THREE.Color(0.95, 0.97, 1.0))
  const uOpacity = uniform(0.8)

  const d = distance(uv(), vec2(0.5, 0.5))
  const a = uOpacity.mul(smoothstep(0.5, 0.15, d))

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  material.colorNode = Fn(() => {
    Discard(a.lessThan(0.01))
    return vec4(uColor, a)
  })()
  material.customProgramCacheKey = () => 'weather-snow-flake-tsl'

  return { material, nodes: { uColor, uOpacity } }
}

export function makeFarSheetMaterialTSL(baseColor, opacity, roundDot) {
  const uColor = uniform(baseColor.clone())
  const uOpacity = uniform(opacity)
  const uFadeNear = uniform(40)
  const uFadeFar = uniform(90)

  const vDist = positionView.z.negate()
  const shape = roundDot
    ? smoothstep(0.5, 0.15, distance(uv(), vec2(0.5, 0.5)))
    : smoothstep(0.0, 0.15, uv().y).mul(smoothstep(1.0, 0.85, uv().y)).mul(oneMinus(abs(uv().x.mul(2.0).sub(1.0))))
  const fadeIn = smoothstep(uFadeNear, uFadeNear.add(8.0), vDist)
  const fadeOut = oneMinus(smoothstep(uFadeFar.sub(10.0), uFadeFar, vDist))
  const a = uOpacity.mul(shape).mul(fadeIn).mul(fadeOut)

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  material.colorNode = Fn(() => {
    Discard(a.lessThan(0.01))
    return vec4(uColor, a)
  })()
  material.customProgramCacheKey = () => `weather-far-sheet-tsl-${roundDot ? 'snow' : 'rain'}`

  return { material, nodes: { uColor, uOpacity, uFadeNear, uFadeFar } }
}
