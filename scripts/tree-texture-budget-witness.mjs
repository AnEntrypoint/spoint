import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modArg = process.argv.find((a) => a.startsWith('--module='))
const modPath = modArg ? path.resolve(modArg.slice('--module='.length)) : path.join(ROOT, 'client/core/TreeTextureBudget.js')
const T = await import(pathToFileURL(modPath).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const outcome = (fn) => {
  try { return { value: fn() } } catch (e) { return { reason: e?.reasonCode ?? `unexpected: ${e?.message ?? e}` } }
}
const parsed = (raw) => outcome(() => T.parseTreeTextureMaxPx(raw, 'src'))
const refusedAs = (raw, reason) => { const o = parsed(raw); return o.reason === reason && !('value' in o) }
const budget = (spec) => outcome(() => T.resolveTreeTextureBudget(spec))

check('number 512 parses to 512', parsed(512).value === 512)
check('"512" parses to 512', parsed('512').value === 512)
check('"64" (the minimum) parses to 64', parsed('64').value === 64)
check('"1024" (the maximum) parses to 1024', parsed('1024').value === 1024)
check('null is no value', parsed(null).value === null)
check('undefined is no value', parsed(undefined).value === null)

const refusals = [
  ['"0x200" (hex) is refused as not-a-number', '0x200', 'not-a-number'],
  ['"0b10000000000" (binary) is refused as not-a-number', '0b10000000000', 'not-a-number'],
  ['"512.0" is refused as not-a-number', '512.0', 'not-a-number'],
  ['" 512" (padded) is refused as not-a-number', ' 512', 'not-a-number'],
  ['"+512" (signed) is refused as not-a-number', '+512', 'not-a-number'],
  ['"1e3" (exponent) is refused as not-a-number', '1e3', 'not-a-number'],
  ['"abc" is refused as not-a-number', 'abc', 'not-a-number'],
  ['NaN is refused as not-a-number', NaN, 'not-a-number'],
  ['true is refused as not-a-number', true, 'not-a-number'],
  ['"" is refused as empty-value', '', 'empty-value'],
  ['"   " is refused as empty-value', '   ', 'empty-value'],
  ['100 is refused as not-a-power-of-two', 100, 'not-a-power-of-two'],
  ['"100" is refused as not-a-power-of-two', '100', 'not-a-power-of-two'],
  ['"32" is refused as below-minimum', '32', 'below-minimum'],
  ['"2048" is refused as above-maximum', '2048', 'above-maximum'],
]
for (const [name, raw, reason] of refusals) check(name, refusedAs(raw, reason), JSON.stringify(parsed(raw)))

check('a query leaftex=256 sets the leaf budget', budget({ search: '?leaftex=256' }).value?.leafMaxPx === 256, JSON.stringify(budget({ search: '?leaftex=256' })))
check('a query leaftex=0x200 is refused as not-a-number', budget({ search: '?leaftex=0x200' }).reason === 'not-a-number', JSON.stringify(budget({ search: '?leaftex=0x200' })))
check('a cfg barkTextureMaxPx=128 sets the bark budget', budget({ cfg: { barkTextureMaxPx: 128 } }).value?.barkMaxPx === 128, JSON.stringify(budget({ cfg: { barkTextureMaxPx: 128 } })))
check('the URL value wins over cfg', budget({ search: '?leaftex=512', cfg: { leafTextureMaxPx: 128 } }).value?.leafMaxPx === 512)
check('no spec gives the defaults 128 and 64', budget({}).value?.leafMaxPx === 128 && budget({}).value?.barkMaxPx === 64)

check('halvingsFor(1024, 256) is 2', outcome(() => T.halvingsFor(1024, 256)).value === 2)
check('halvingsFor(1024, "256") is 2', outcome(() => T.halvingsFor(1024, '256')).value === 2)
check('halvingsFor(1024, "0x100") is refused as not-a-number', outcome(() => T.halvingsFor(1024, '0x100')).reason === 'not-a-number', JSON.stringify(outcome(() => T.halvingsFor(1024, '0x100'))))
check('halvingsFor(0, 256) is refused as not-a-texture-width', outcome(() => T.halvingsFor(0, 256)).reason === 'not-a-texture-width')

const failed = results.filter((ok) => !ok).length
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} tree texture budget: ${results.length - failed}/${results.length} checks pass, module ${path.relative(ROOT, modPath)}`)
process.exit(failed === 0 ? 0 : 1)
