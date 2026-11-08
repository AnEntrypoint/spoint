import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSL_DIR = path.join(ROOT, 'packages', 'mapspinner', 'src', 'tsl')
const load = (name) => import(pathToFileURL(path.join(TSL_DIR, name)).href)

const failures = []
const report = (ok, line) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${line}`)
  if (!ok) failures.push(line)
}
const attempt = (fn) => {
  try {
    return { value: fn() }
  } catch (err) {
    return { code: err && err.code, message: err && err.message }
  }
}

console.log('NOTE: the TSL side is a JS copy of the formula (tslSkyBalanced and the scalar terrainSkyIrradiance), not the TSL node graph.')
console.log('NOTE: TSL node graphs are not evaluated here (no GPU, no node builder in node); a numeric GPU evaluation is blocked in this environment.')

const TONE_MAPPING_CODE = 'unknown-tone-mapping-mode'
const KNOWN_MODES = [
  { mode: 0, name: 'NoToneMapping (knob Linear)' },
  { mode: 4, name: 'ACESFilmicToneMapping' },
  { mode: 6, name: 'AgXToneMapping (renderer maps, TSL identity)' },
  { mode: 7, name: 'NeutralToneMapping (renderer maps, TSL identity)' },
]
const UNKNOWN_MODES = [1, 2, 3, 5, -1, 1.5, NaN, '4', undefined, null]

const display = await load('display-referred-tsl.js')
if (typeof display.readToneMappingMode !== 'function') {
  report(false, 'tone mapping: readToneMappingMode is not exported, so no unknown mode is refused')
} else {
  for (const mode of UNKNOWN_MODES) {
    const got = attempt(() => display.readToneMappingMode(mode))
    const refused = got.code === TONE_MAPPING_CODE
    report(refused, `tone mapping: mode ${String(mode)} ${refused ? `refused with code ${got.code}` : `NOT refused (value ${String(got.value)})`}`)
  }
  for (const { mode, name } of KNOWN_MODES) {
    const got = attempt(() => display.readToneMappingMode(mode))
    report(got.value === mode, `tone mapping: known mode ${mode} (${name}) ${got.value === mode ? 'accepted' : `rejected (${got.code ?? got.message})`}`)
  }
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'client', 'core', 'RenderControls.js'), 'utf8')
  const resolverBody = rendererSrc.match(/function _resolveToneMappingConstant[\s\S]*?\n}\n/)?.[0] ?? ''
  const three = await import('three')
  const knobModes = [...resolverBody.matchAll(/THREE\.(\w+)/g)].map(([, name]) => three[name])
  const knownSet = KNOWN_MODES.map((k) => k.mode).sort((a, b) => a - b)
  const knobSet = [...new Set(knobModes)].sort((a, b) => a - b)
  report(resolverBody.length > 0 && JSON.stringify(knobSet) === JSON.stringify(knownSet), `tone mapping: the values RenderControls _resolveToneMappingConstant can set [${knobSet.join(',')}] equal the accepted set [${knownSet.join(',')}]`)
}

const shared = await load('terrain-ambient-shared.js')
const glslMix = (x, y, a) => x * (1 - a) + y * a
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const tslSkyBalanced = ({ muS, ndotUp, skyFill, solar, rayleigh }) => {
  const day = smoothstep(shared.SKY_DAY_MU[0], shared.SKY_DAY_MU[1], muS)
  const hemi = (ndotUp + 1) * 0.5
  const tint = rayleigh.map((c) => glslMix(1, c / rayleigh[0], shared.RAYLEIGH_SKY_TINT))
  const skyIrr = solar.map((s, i) => s * shared.SKY_IRRADIANCE_SCALE * day * tint[i] * hemi)
  const grey = shared.luma(skyIrr)
  return skyIrr.map((s, i) => glslMix(grey, s, shared.SKY_BALANCE_TO_GREY) * skyFill * shared.SKY_FILL_TINT[i])
}
const RAYLEIGH_EARTH = [5.8e-6, 13.5e-6, 33.1e-6]
const TINT_SAMPLES = [
  { muS: 0.3, ndotUp: 0.5, skyFill: 1, solar: [1.0, 0.9, 0.8], rayleigh: RAYLEIGH_EARTH },
  { muS: 0.1, ndotUp: 0.9, skyFill: 1, solar: [1, 1, 1], rayleigh: RAYLEIGH_EARTH },
  { muS: 1, ndotUp: 1, skyFill: 0.7, solar: [2, 2, 2], rayleigh: [1, 1, 1] },
  { muS: -0.05, ndotUp: -0.3, skyFill: 1.2, solar: [0.5, 0.4, 0.3], rayleigh: [2, 1, 0.5] },
]
for (const sample of TINT_SAMPLES) {
  const got = shared.terrainSkyIrradiance({ ...sample })
  const want = tslSkyBalanced(sample)
  const maxDiff = Math.max(...want.map((w, i) => Math.abs(w - got[i])))
  report(maxDiff < 1e-12, `sky tint: muS=${sample.muS} ndotUp=${sample.ndotUp} rayleigh=[${sample.rayleigh.join(',')}] scalar-vs-TSL max abs diff ${maxDiff.toExponential(3)}`)
}

const lightingSrc = fs.readFileSync(path.join(TSL_DIR, 'terrain-lighting-tsl.js'), 'utf8')
const literalAces = /2\.51|2\.43/.test(lightingSrc)
report(!literalAces, 'ACES: terrain-lighting-tsl.js carries no literal ACES coefficient (2.51 / 2.43)')
report(/\bACES_FILMIC\b/.test(lightingSrc) && shared.ACES_FILMIC.length === 5, 'ACES: terrain-lighting-tsl.js reads the shared ACES_FILMIC constant')

console.log(`RESULT: ${failures.length ? 'FAIL' : 'PASS'}`)
process.exit(failures.length ? 1 : 0)
