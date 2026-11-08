import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await installSpecifierHooks()
const { searchBookmark, RelocationSearchNoDataError } = await import(pathToFileURL(path.join(ROOT, 'client/core/RelocationSearch.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const FLAT_FRAME = { offsetY: 0, anchorHeight: 0 }
const ctxFor = (heightAt, seed) => ({ frame: FLAT_FRAME, heightAt, sampler: { anchorField: null }, seed })
const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

const shoreWithGap = (x) => (x < 1000 ? 5 : x < 1100 ? NaN : -5)
const shoreNoGap = (x) => (x < 1000 ? 5 : -5)

const gapped = await settled(searchBookmark('coast', ctxFor(shoreWithGap, 11)))
check('a coast with a no-data gap across the shoreline finds no crossing inside the gap', gapped.error !== undefined && /nothing found near the origin/.test(gapped.error.message) && gapped.error.noData > 0 && gapped.error.sampled > gapped.error.noData, JSON.stringify(gapped.value ?? { message: gapped.error?.message, noData: gapped.error?.noData, sampled: gapped.error?.sampled }))

const whole = await settled(searchBookmark('coast', ctxFor(shoreNoGap, 12)))
check('the same coast search with no gap finds the shoreline at x of 1000 with no no-data sample', whole.value !== undefined && Math.abs(whole.value.x - 1000) < 1 && Math.abs(whole.value.z) < 1 && whole.value.noData === 0, JSON.stringify(whole.value ?? whole.error?.message))

const allNaN = () => NaN
const coastDead = await settled(searchBookmark('coast', ctxFor(allNaN, 21)))
check('a coast whose every sample is no-data throws RelocationSearchNoDataError', coastDead.error instanceof RelocationSearchNoDataError, coastDead.error?.message ?? 'resolved')
check('the all-no-data error carries its code, kind and counts and names the origin', coastDead.error?.code === 'SEARCH_NO_DATA' && coastDead.error?.kind === 'coast' && coastDead.error?.noData === coastDead.error?.sampled && coastDead.error?.message.includes('no finite terrain was sampled near the origin'))
const hillsDead = await settled(searchBookmark('hills', ctxFor(allNaN, 22)))
check('a hill search whose every sample is no-data throws the same distinct error', hillsDead.error instanceof RelocationSearchNoDataError && hillsDead.error.kind === 'hills', hillsDead.error?.message ?? 'resolved')

const base = (x, z) => (x === 1000 && z === 0 ? 200 : x === -2000 && z === 500 ? 80 : 10)
const inHole = (x, z) => Math.abs(x - 1000) <= 300 && Math.abs(z) <= 300
const holed = await settled(searchBookmark('hills', ctxFor((x, z) => (inHole(x, z) ? NaN : base(x, z)), 31)))
check('a hill search with a no-data hole returns the highest finite point, not the hole', holed.value !== undefined && holed.value.x === -2000 && holed.value.z === 500, JSON.stringify(holed.value ?? holed.error?.message))
check('the hole is counted as the 9 no-data samples it covers', holed.value?.noData === 9, `noData=${holed.value?.noData}`)

let calls = 0
const counting = (x, z) => { calls++; return base(x, z) }
const first = await searchBookmark('hills', ctxFor(counting, 41))
const afterFirst = calls
const second = await searchBookmark('hills', ctxFor(counting, 41))
check('the same kind and seed returns the same result object without sampling again', second === first && calls === afterFirst, `calls=${calls} afterFirst=${afterFirst}`)
await searchBookmark('hills', ctxFor(counting, 42))
check('a different seed runs a new search', calls > afterFirst)

let broken = true
const flaky = (x, z) => { if (broken) throw new Error('sampler down'); return base(x, z) }
const thrown = await settled(searchBookmark('hills', ctxFor(flaky, 51)))
check('a synchronous sampler throw rejects the search with its own message', thrown.error?.message === 'sampler down', thrown.error?.message ?? 'resolved')
broken = false
const retried = await settled(searchBookmark('hills', ctxFor(flaky, 51)))
check('a rejected search is not cached: the same key runs again and succeeds', retried.value !== undefined && retried.value.x === 1000 && retried.value.z === 0, retried.error?.message ?? JSON.stringify(retried.value))

let dead = true
const toggled = (x, z) => (dead ? NaN : base(x, z))
const deadFirst = await settled(searchBookmark('hills', ctxFor(toggled, 61)))
dead = false
const deadRetry = await settled(searchBookmark('hills', ctxFor(toggled, 61)))
check('an all-no-data failure is not cached: once the terrain has data the same key succeeds', deadFirst.error instanceof RelocationSearchNoDataError && deadRetry.value !== undefined && deadRetry.value.noData === 0, deadRetry.error?.message ?? JSON.stringify(deadRetry.value))

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS RelocationSearch treats NaN as no data: coast takes no crossing across a no-data gap, an all-no-data search throws RelocationSearchNoDataError, a hill search skips a hole to its highest finite point, and the cache returns one result per kind and seed without caching a failure')
process.exit(0)
