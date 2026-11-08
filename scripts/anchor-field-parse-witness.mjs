import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const { createAnchorField } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/anchor-field.js')).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[anchor-field-parse] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const thrownBy = (fn) => { try { fn(); return null } catch (e) { return e } }
const hasCode = (e) => e != null && typeof e.code === 'string' && e.code.length > 0

const SAMPLE_DIRS = [[0.31, 0.52, 0.79], [-0.6, 0.2, 0.77], [0.1, -0.9, 0.4], [0.8, 0.1, -0.3]]
const DIR = SAMPLE_DIRS[0]
const signature = (af) => SAMPLE_DIRS.map((d) => { const s = af.sampleDir(d); return af.PARAM_KEYS.map((k) => s[k]).join(',') }).join('|')

const seed0 = signature(createAnchorField({ seed: 0 }))
const seed1337 = signature(createAnchorField({ seed: 1337 }))
check('seed 0 is a real seed, not the 1337 default', seed0 !== seed1337)
check('absent seed takes the 1337 default', signature(createAnchorField({})) === seed1337)
check('seed 0 is deterministic across instances', signature(createAnchorField({ seed: 0 })) === seed0)

for (const bad of [1.5, NaN, 'abc', Infinity]) {
  const e = thrownBy(() => createAnchorField({ seed: bad }))
  check(`non-integer seed ${String(bad)} throws a coded error`, hasCode(e), e ? `code=${e.code}` : 'no throw')
}

const src = createAnchorField({ seed: 7 })
src.editAtDir(0, DIR, { seaBias: 0.5 })
const full = src.serialize()
const fresh = createAnchorField({ seed: 7 })
check('full version-2 load round-trips', fresh.load(full) === true && signature(fresh) === signature(src))

const bandCount = src.BANDS.length
const truncated = JSON.parse(full)
truncated.bands = truncated.bands.slice(0, bandCount - 1)
const partialJson = JSON.stringify(truncated)
const target = createAnchorField({ seed: 7 })
target.editAtDir(bandCount - 1, DIR, { elevAmp: 0.25 })
const before = signature(target)
const partialErr = thrownBy(() => target.load(partialJson))
check('partial version-2 load throws a coded error', hasCode(partialErr), partialErr ? `code=${partialErr.code}` : 'returned without refusing')
check('partial version-2 load leaves the field unchanged', signature(target) === before)

const unknownErr = thrownBy(() => createAnchorField({ seed: 7 }).load(JSON.stringify({ version: 9, bands: [] })))
check('unknown version throws a coded error', hasCode(unknownErr), unknownErr ? `code=${unknownErr.code}` : 'returned without refusing')

const failed = results.filter((ok) => !ok).length
console.log(`[anchor-field-parse] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
