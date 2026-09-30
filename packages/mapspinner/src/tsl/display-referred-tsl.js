import { float, vec3, uniform, select, pow, sqrt, max, clamp, mat3 } from 'three/tsl'

const TONE_MAPPING_LINEAR = 1
const TONE_MAPPING_REINHARD = 2
const TONE_MAPPING_ACES = 4
const DISPLAY_CLAMP = 0.995
const ACES_INPUT_ROWS = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]]
const ACES_OUTPUT_ROWS = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]]

function invertRows3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

const matrixInThreeAcesConvention = (rows) => mat3(...rows.flat())
const acesInputInverse = matrixInThreeAcesConvention(invertRows3(ACES_INPUT_ROWS))
const acesOutputInverse = matrixInThreeAcesConvention(invertRows3(ACES_OUTPUT_ROWS))

const toneMappingMode = uniform(TONE_MAPPING_ACES, 'int').onRenderUpdate(({ renderer }) => renderer.toneMapping | 0)
const toneMappingExposure = uniform(1.0).onRenderUpdate(({ renderer }) => renderer.toneMappingExposure || 1.0)

const srgbToLinear = (c) => select(c.lessThanEqual(vec3(0.04045)), c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)))

function invertAcesFilmic(t) {
  const z = clamp(acesOutputInverse.mul(t), vec3(0.0), vec3(DISPLAY_CLAMP))
  const a = z.mul(0.983729).sub(1.0)
  const b = z.mul(0.983729 * 0.4329510).sub(0.0245786)
  const c = z.mul(0.238081).add(0.000090537)
  const y = b.negate().sub(sqrt(max(b.mul(b).sub(a.mul(c).mul(4.0)), vec3(0.0)))).div(a.mul(2.0))
  return max(acesInputInverse.mul(y), vec3(0.0)).mul(float(0.6).div(toneMappingExposure))
}

export function displayReferredToSceneLinear(display) {
  const t = clamp(srgbToLinear(display), vec3(0.0), vec3(DISPLAY_CLAMP))
  return select(toneMappingMode.equal(TONE_MAPPING_ACES), invertAcesFilmic(t),
    select(toneMappingMode.equal(TONE_MAPPING_REINHARD), t.div(vec3(1.0).sub(t)).div(toneMappingExposure),
      select(toneMappingMode.equal(TONE_MAPPING_LINEAR), t.div(toneMappingExposure), t)))
}
