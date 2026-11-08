import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const { createHeightSampler } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/height-cpu.js')).href)
const { RELIEF_DESIGN_RADIUS_M } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/terrain-defaults.js')).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[height-cpu-relief] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const thrownBy = (fn) => { try { fn(); return null } catch (e) { return e } }
const hasCode = (e) => e != null && typeof e.code === 'string' && e.code.length > 0

const DIR = [0.31, 0.52, 0.79]
const RADIUS = 6360
const defaultScale = RADIUS / RELIEF_DESIGN_RADIUS_M
const heightWith = (opts) => createHeightSampler(opts).heightAt(DIR)

for (const bad of [NaN, Infinity, -Infinity, '2', true, {}]) {
  const e = thrownBy(() => createHeightSampler({ reliefScale: bad }))
  check(`reliefScale ${typeof bad === 'object' ? JSON.stringify(bad) : String(bad)} (${typeof bad}) throws a coded error`, hasCode(e), e ? `code=${e.code}` : 'no throw')
}

const absent = heightWith({})
check('absent reliefScale takes the design default', absent === heightWith({ reliefScale: defaultScale }))
check('null reliefScale takes the design default', heightWith({ reliefScale: null }) === absent)

const h1 = heightWith({ reliefScale: 1 })
const h2 = heightWith({ reliefScale: 2 })
check('finite reliefScale scales the height linearly', Math.abs(h2 - 2 * h1) < 1e-9, `h1=${h1} h2=${h2}`)

const failed = results.filter((ok) => !ok).length
console.log(`[height-cpu-relief] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
