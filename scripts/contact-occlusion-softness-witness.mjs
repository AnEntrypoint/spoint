import {
  CONTACT_FIELD,
  createContactField,
  contactFieldLoadChunk,
  rockContactStamps,
  treeContactStamps,
} from '../src/terrain/ContactOcclusionField.js'

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

const SCALE = 20
const CENTRE = 256
const RATIO_TOL = 0.12

const WITNESS_TEXEL_M = 0.25

function fieldWithStamp(stamp) {
  const field = createContactField({ windowM: CONTACT_FIELD.WINDOW_M, texelM: WITNESS_TEXEL_M })
  contactFieldLoadChunk(field, 'w0', [stamp])
  return field
}

function falloffWidth(field, stamp) {
  const j = Math.floor((stamp.z - field.originZ) / field.texelM)
  const row = j * field.size
  const peak = stamp.strength
  const hi = 0.9 * peak
  const lo = 0.1 * peak
  let dHi = -1
  let dLo = -1
  const start = Math.floor((stamp.x - field.originX) / field.texelM)
  for (let i = start; i < field.size; i++) {
    const d = field.originX + (i + 0.5) * field.texelM - stamp.x
    const darkness = (CONTACT_FIELD.FULL_LIGHT - field.data[row + i]) / CONTACT_FIELD.FULL_LIGHT
    if (darkness >= hi) dHi = d
    if (darkness >= lo) dLo = d
  }
  return dLo - dHi
}

function peakDarkness(field, stamp) {
  const j = Math.floor((stamp.z - field.originZ) / field.texelM)
  const row = j * field.size
  let min = CONTACT_FIELD.FULL_LIGHT
  for (let i = 0; i < field.size; i++) if (field.data[row + i] < min) min = field.data[row + i]
  return (CONTACT_FIELD.FULL_LIGHT - min) / CONTACT_FIELD.FULL_LIGHT
}

function softnessRatio(label, baseSpanM, strength, r0, shipped) {
  const hard = { x: CENTRE, z: CENTRE, r0, r1: r0 + baseSpanM, strength }
  const soft = { x: CENTRE, z: CENTRE, r0, r1: r0 + baseSpanM * CONTACT_FIELD.FALLOFF_SOFTNESS, strength }
  const wHard = falloffWidth(fieldWithStamp(hard), hard)
  const wSoft = falloffWidth(fieldWithStamp(soft), soft)
  const wShipped = falloffWidth(fieldWithStamp(shipped), shipped)
  const ratio = wSoft / wHard
  console.log(`  ${label}: base span ${baseSpanM}m -> 90%-10% falloff ${wHard}m; softened span ${baseSpanM * CONTACT_FIELD.FALLOFF_SOFTNESS}m -> ${wSoft}m; ratio ${ratio.toFixed(3)}; shipped stamp ${wShipped}m`)
  check(`${label} softened falloff is ${CONTACT_FIELD.FALLOFF_SOFTNESS}x the unsoftened falloff`, Math.abs(ratio - CONTACT_FIELD.FALLOFF_SOFTNESS) <= RATIO_TOL, `ratio ${ratio}`)
  check(`${label} shipped stamp measures as the softened one`, Math.abs(wShipped - wSoft) <= 1.0, `shipped ${wShipped} vs softened ${wSoft}`)
  check(`${label} shipped span is ${CONTACT_FIELD.FALLOFF_SOFTNESS}x base`, Math.abs((shipped.r1 - shipped.r0) - baseSpanM * CONTACT_FIELD.FALLOFF_SOFTNESS) < 1e-9, `span ${shipped.r1 - shipped.r0}`)
  check(`${label} dark core radius untouched by softness`, Math.abs(shipped.r0 - r0) < 1e-9, `r0 ${shipped.r0}`)
  const peak = peakDarkness(fieldWithStamp(shipped), shipped)
  check(`${label} peak darkness untouched by softness`, Math.abs(peak - strength) <= 0.02, `peak ${peak} vs ${strength}`)
}

const tree = treeContactStamps([{ x: CENTRE, z: CENTRE, scale: SCALE, species: 0 }])[0]
const rock = rockContactStamps([{ x: CENTRE, z: CENTRE, scale: SCALE }])[0]

check('FALLOFF_SOFTNESS is 2', CONTACT_FIELD.FALLOFF_SOFTNESS === 2, `got ${CONTACT_FIELD.FALLOFF_SOFTNESS}`)

const TREE_R0 = (0.35 * SCALE + 0.3) * CONTACT_FIELD.TREE_ZONE_SCALE
const TREE_BASE_SPAN = 1.8 * SCALE * CONTACT_FIELD.TREE_ZONE_SCALE
const ROCK_R0 = 0.5 * SCALE
const ROCK_BASE_SPAN = 0.5 * SCALE

softnessRatio('tree', TREE_BASE_SPAN, CONTACT_FIELD.TREE_STRENGTH, TREE_R0, tree)
softnessRatio('rock', ROCK_BASE_SPAN, CONTACT_FIELD.ROCK_STRENGTH, ROCK_R0, rock)

const bush = treeContactStamps([{ x: CENTRE, z: CENTRE, scale: SCALE, species: 4 }])[0]
softnessRatio('bush', 1.2 * SCALE, CONTACT_FIELD.BUSH_STRENGTH, 0.6 * SCALE, bush)

console.log(`\n  passed ${PASS.length}, failed ${FAIL.length}`)
console.log(FAIL.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(FAIL.length === 0 ? 0 : 1)
