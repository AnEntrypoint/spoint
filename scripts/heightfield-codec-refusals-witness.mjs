import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const { encodeHeightfield, decodeHeightfield } = await import(pathToFileURL(resolve(ROOT, 'packages/mapspinner/src/heightfield-codec.js')).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[heightfield-codec-refusals] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const thrownBy = (fn) => { try { return { value: fn() } } catch (e) { return { error: e } } }

const N = 4
const q = Array.from({ length: N * N }, (_, i) => i * 1000)
const artifact = {
  N, extent: 3, center: [0, 0], anchorDir: [0, 1, 0], radius: 6360, reliefScale: 1, anchorHeight: 0,
  seed: 1, hashVersion: 2, terrainKey: 'k', codeVersion: 'c',
  sectors: { gridS: 1, nodesPerSector: N, bits: 16 },
  sectorMin: [0], sectorMax: [15000], q,
}
const valid = encodeHeightfield(artifact)
const roundTrip = decodeHeightfield(valid)
check('valid artifact decodes and keeps its quantized nodes', roundTrip && roundTrip.q.length === N * N && roundTrip.q[15] === 15000)

const codeOf = (buf) => { const r = thrownBy(() => decodeHeightfield(buf)); return r.error ? (r.error.code ?? `uncoded:${r.error.name}`) : `returned:${r.value === null ? 'null' : 'value'}` }

check('missing buffer refuses with heightfield-missing', codeOf(undefined) === 'heightfield-missing', codeOf(undefined))
check('null buffer refuses with heightfield-missing', codeOf(null) === 'heightfield-missing', codeOf(null))
check('short buffer refuses with heightfield-short', codeOf(new ArrayBuffer(4)) === 'heightfield-short', codeOf(new ArrayBuffer(4)))

const badMagic = valid.slice(0)
new Uint8Array(badMagic)[0] ^= 0xff
check('bad magic refuses with heightfield-bad-magic', codeOf(badMagic) === 'heightfield-bad-magic', codeOf(badMagic))

const chopped = valid.slice(0, valid.byteLength - 10)
check('body-truncated buffer refuses with heightfield-truncated', codeOf(chopped) === 'heightfield-truncated', codeOf(chopped))
const headerCut = valid.slice(0, 12)
check('header-truncated buffer refuses with heightfield-truncated', codeOf(headerCut) === 'heightfield-truncated', codeOf(headerCut))

const failed = results.filter((ok) => !ok).length
console.log(`[heightfield-codec-refusals] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
