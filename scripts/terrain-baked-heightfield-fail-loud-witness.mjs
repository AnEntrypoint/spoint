import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadBakedHeightField, BakedSourceMissingError } from '../src/terrain/TerrainPhysics.js'
import { nodeBakedSource, browserBakedSource } from '../src/terrain/BakedSourceAdapter.js'
import { HEIGHTFIELD_BAKE_CODE_VERSION } from '../src/static/BakeCodeVersion.js'

const NODE = nodeBakedSource()
const CORE_PATH = join(process.cwd(), 'src/terrain/TerrainPhysics.js')

const FIXTURE_DIR = join(tmpdir(), 'spoint-baked-heightfield-witness').replace(/\\/g, '/')
rmSync(FIXTURE_DIR, { recursive: true, force: true })
mkdirSync(FIXTURE_DIR, { recursive: true })

const PASS = []
const FAIL = []
function expect(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

const TCFG = { seed: 1, radius: 6000, reliefScale: 1, anchorDir: [0, 1, 0], hashVersion: 2 }
const FRAME = { chartEpoch: 0 }

function artifactJson(overrides = {}) {
  return {
    N: 3, extent: 100, center: [0, 0], heights: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    hashVersion: 2, codeVersion: HEIGHTFIELD_BAKE_CODE_VERSION, radius: TCFG.radius,
    reliefScale: TCFG.reliefScale, anchorDir: [0, 1, 0], chartEpoch: 0,
    ...overrides,
  }
}

function writeFixture(name, bytes) {
  const path = `${FIXTURE_DIR}/${name}`
  writeFileSync(path, bytes)
  return path
}

async function withCapturedWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try { return { result: await fn(), warnings, error: null } }
  catch (error) { return { result: undefined, warnings, error } }
  finally { console.warn = original }
}

const absentPath = `${FIXTURE_DIR}/absent.hf`
const absent = await withCapturedWarnings(() => loadBakedHeightField(absentPath, 2, TCFG, FRAME, NODE))
expect('absent artifact returns null without throwing', absent.error === null && absent.result === null,
  absent.error ? `threw ${absent.error.message}` : `returned ${JSON.stringify(absent.result)}`)
expect('absent artifact emits no warning (silent CPU fallback)', absent.warnings.length === 0, `warnings: ${absent.warnings.join(' | ')}`)

const truncated = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('truncated.hf', new Uint8Array(5)), 2, TCFG, FRAME, NODE))
expect('truncated artifact throws [baked-heightfield]',
  truncated.error?.message.startsWith('[baked-heightfield]') && truncated.error.message.includes('truncated'),
  truncated.error ? truncated.error.message : 'no throw')

const badMagicBytes = new Uint8Array(16)
new DataView(badMagicBytes.buffer).setUint32(0, 0xdeadbeef, true)
const badMagic = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('badmagic.hf', badMagicBytes), 2, TCFG, FRAME, NODE))
expect('bad-magic artifact throws [baked-heightfield]',
  badMagic.error?.message.startsWith('[baked-heightfield]') && badMagic.error.message.includes('not a heightfield'),
  badMagic.error ? badMagic.error.message : 'no throw')

const staleJson = JSON.stringify(artifactJson({ codeVersion: 'stale000000' }))
const stale = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('stale.json', staleJson), 2, TCFG, FRAME, NODE))
expect('stale-code artifact throws [baked-heightfield]',
  stale.error?.message.startsWith('[baked-heightfield]') && stale.error.message.includes('stale bake'),
  stale.error ? stale.error.message : 'no throw')

const hashJson = JSON.stringify(artifactJson({ hashVersion: 1 }))
const hashMismatch = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('hash.json', hashJson), 2, TCFG, FRAME, NODE))
expect('hashVersion mismatch warns and returns null',
  hashMismatch.error === null && hashMismatch.result === null && hashMismatch.warnings.length === 1 && hashMismatch.warnings[0].includes('hashVersion'),
  hashMismatch.error ? hashMismatch.error.message : `result ${JSON.stringify(hashMismatch.result)}, warnings ${hashMismatch.warnings.length}`)

const keyJson = JSON.stringify(artifactJson({ terrainKey: 'ffffffff' }))
const keyMismatch = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('key.json', keyJson), 2, TCFG, FRAME, NODE))
expect('terrainKey mismatch warns and returns null',
  keyMismatch.error === null && keyMismatch.result === null && keyMismatch.warnings.length === 1 && keyMismatch.warnings[0].includes('terrain key'),
  keyMismatch.error ? keyMismatch.error.message : `result ${JSON.stringify(keyMismatch.result)}, warnings ${keyMismatch.warnings.length}`)

const epochJson = JSON.stringify(artifactJson({ chartEpoch: 3 }))
const epochMismatch = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('epoch.json', epochJson), 2, TCFG, FRAME, NODE))
expect('chartEpoch mismatch warns and returns null',
  epochMismatch.error === null && epochMismatch.result === null && epochMismatch.warnings.length === 1 && epochMismatch.warnings[0].includes('chartEpoch'),
  epochMismatch.error ? epochMismatch.error.message : `result ${JSON.stringify(epochMismatch.result)}, warnings ${epochMismatch.warnings.length}`)

const matchJson = JSON.stringify(artifactJson())
const matched = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('match.json', matchJson), 2, TCFG, FRAME, NODE))
const field = matched.result
expect('matching artifact loads a field with verified code version',
  matched.error === null && field !== null && field.codeVersionVerified === true && field.covers(0, 0),
  matched.error ? matched.error.message : `field ${field === null ? 'null' : 'built, verified=' + field?.codeVersionVerified}`)
expect('matching artifact samples the centre of a 3x3 ramp at 4.0', field !== null && Math.abs(field.heightAtLocal(0, 0) - 4) < 1e-9,
  field ? `sampled ${field.heightAtLocal(0, 0)}` : 'no field')

// ACCEPTPORT-orch-main-w1-30-1: the leak this port closes. The module that decides what the ground
// is must parse where neither primitive exists, so the read is a fact of the caller, not of the file.
const core = readFileSync(CORE_PATH, 'utf8')
expect('src/terrain/TerrainPhysics.js references no node:fs', !core.includes('node:fs'),
  `found node:fs at ${core.split('\n').findIndex(l => l.includes('node:fs')) + 1}`)
expect('src/terrain/TerrainPhysics.js references no fetch(', !/\bfetch\s*\(/.test(core),
  `found fetch( at ${core.split('\n').findIndex(l => /\bfetch\s*\(/.test(l)) + 1}`)

// A caller that supplies no source is refused, not guessed at: a guessed platform is the silent
// default that turns an unreadable bake into a quiet CPU fallback.
const refused = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('refused.json', matchJson), 2, TCFG, FRAME))
expect('no baked source is refused with a named error, not read', refused.result === undefined && refused.error instanceof BakedSourceMissingError && refused.error.code === 'baked-source-missing',
  refused.error ? `threw ${refused.error.name} code=${refused.error.code}` : `returned ${JSON.stringify(refused.result)}`)
const partial = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('partial.json', matchJson), 2, TCFG, FRAME, { readBytes: NODE.readBytes }))
expect('an incomplete baked source is refused for the function it lacks', partial.result === undefined && partial.error instanceof BakedSourceMissingError && partial.error.missing === 'heightfieldCodec',
  partial.error ? `threw ${partial.error.name} missing=${partial.error.missing}` : `returned ${JSON.stringify(partial.result)}`)
expect('a refused source reads no bytes and warns nothing', refused.warnings.length === 0 && partial.warnings.length === 0,
  `${refused.warnings.length + partial.warnings.length} warning(s)`)

// The same artifact through an in-memory port, so the loader is proven to read what it is given and
// not the filesystem it used to reach for.
const memoryBytes = new TextEncoder().encode(matchJson)
const memory = await withCapturedWarnings(() => loadBakedHeightField(writeFixture('match2.json', matchJson), 2, TCFG, FRAME, {
  readBytes: async () => memoryBytes,
  heightfieldCodec: async () => ({ decodeHeightfield: () => { throw new Error('a .json artifact is not a heightfield') } }),
  bakeCodeVersion: async () => HEIGHTFIELD_BAKE_CODE_VERSION,
}))
expect('an in-memory readBytes port loads the same field the filesystem does',
  memory.error === null && memory.result !== null && memory.result.codeVersionVerified === true
    && Math.abs(memory.result.heightAtLocal(0, 0) - field.heightAtLocal(0, 0)) < 1e-9,
  memory.error ? memory.error.message : `sampled ${memory.result?.heightAtLocal(0, 0)} vs fs ${field?.heightAtLocal(0, 0)}`)

// The browser adapter, driven by a stubbed fetch so both of its refusals are measured: HTTP 404 is
// the absent artifact (null, no throw), anything else is [baked-heightfield].
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => memoryBytes.buffer.slice(memoryBytes.byteOffset, memoryBytes.byteOffset + memoryBytes.byteLength) })
const browser = await withCapturedWarnings(() => loadBakedHeightField('/worlds/match.json', 2, TCFG, FRAME, browserBakedSource()))
expect('the browser adapter decodes the bytes fetch returned', browser.error === null && browser.result !== null && Math.abs(browser.result.heightAtLocal(0, 0) - 4) < 1e-9,
  browser.error ? browser.error.message : `sampled ${browser.result?.heightAtLocal(0, 0)}`)
globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' })
const notFound = await withCapturedWarnings(() => loadBakedHeightField('/worlds/absent.json', 2, TCFG, FRAME, browserBakedSource()))
expect('HTTP 404 is the absent artifact: null with no throw and no warning', notFound.error === null && notFound.result === null && notFound.warnings.length === 0,
  notFound.error ? notFound.error.message : `result ${JSON.stringify(notFound.result)}, warnings ${notFound.warnings.length}`)
globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error' })
const serverError = await withCapturedWarnings(() => loadBakedHeightField('/worlds/broken.json', 2, TCFG, FRAME, browserBakedSource()))
expect('HTTP 500 throws [baked-heightfield]', serverError.error?.message.startsWith('[baked-heightfield]') && serverError.error.message.includes('HTTP 500'),
  serverError.error ? serverError.error.message : 'no throw')
globalThis.fetch = async () => { throw new Error('network down') }
const networkError = await withCapturedWarnings(() => loadBakedHeightField('/worlds/broken.json', 2, TCFG, FRAME, browserBakedSource()))
expect('a fetch that rejects throws [baked-heightfield] cannot be read', networkError.error?.message.startsWith('[baked-heightfield]') && networkError.error.message.includes('cannot be read'),
  networkError.error ? networkError.error.message : 'no throw')
globalThis.fetch = realFetch

rmSync(FIXTURE_DIR, { recursive: true, force: true })
console.log(`pass ${PASS.length} fail ${FAIL.length}`)
console.log(`RESULT: ${FAIL.length === 0 ? 'PASS' : 'FAIL'}`)
process.exit(FAIL.length === 0 ? 0 : 1)
