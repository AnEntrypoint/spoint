import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

globalThis.OffscreenCanvas = class OffscreenCanvasStub {}
globalThis.createImageBitmap = async () => { throw new Error('stub createImageBitmap is never reached: the texture fetch fails first') }

const textureFetches = []
globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  if (url.pathname.includes('/textures/')) {
    textureFetches.push(url.pathname)
    return { ok: false, status: 503, blob: async () => { throw new Error('stub texture fetch') } }
  }
  const file = fileURLToPath(url)
  return { ok: true, status: 200, text: async () => readFileSync(file, 'utf8') }
}

const gl = new Proxy({}, {
  get(_, key) {
    if (typeof key !== 'string') return undefined
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) return 0
    if (key === 'getProgramParameter' || key === 'getShaderParameter') return () => true
    return () => undefined
  },
})

const { initMapspinnerRender } = await import('../packages/mapspinner/src/gl-render.js')

const TILE_W_CODE = 'mapspinner-tile-w-invalid'
const ABSENT = Symbol('absent')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const expect = (name, ok, detail) => {
  checks.push(ok)
  console.log(`CHECK ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

async function initErrorCode(tileW) {
  const opts = { bakeOnly: true }
  if (tileW !== ABSENT) opts.tileW = tileW
  try {
    await initMapspinnerRender(gl, opts)
    return { code: null, message: 'resolved' }
  } catch (e) {
    return { code: e && e.code !== undefined ? e.code : null, message: String(e && e.message) }
  }
}

for (const [label, value] of [['tileW 0', 0], ['tileW NaN', NaN], ['tileW -4', -4], ['tileW 1.5', 1.5], ['tileW Infinity', Infinity]]) {
  const r = await initErrorCode(value)
  expect(`${label} is refused with code ${TILE_W_CODE}`, r.code === TILE_W_CODE, `code=${r.code} message=${r.message}`)
}

const absent = await initErrorCode(ABSENT)
expect('absent tileW takes the default (no tileW refusal)', absent.code !== TILE_W_CODE, `code=${absent.code} message=${absent.message}`)

const explicit = await initErrorCode(32)
expect('valid tileW 32 is accepted (no tileW refusal)', explicit.code !== TILE_W_CODE, `code=${explicit.code} message=${explicit.message}`)

async function settleTextureFetches(from) {
  for (let i = 0; i < 80 && textureFetches.length === from; i++) await sleep(25)
  await sleep(50)
  return textureFetches.length
}

const beforeFirst = textureFetches.length
try { await initMapspinnerRender(gl, {}) } catch (_) {}
const afterFirst = await settleTextureFetches(beforeFirst)
expect('first decode attempt fetches surface textures', afterFirst > beforeFirst, `fetches=${afterFirst - beforeFirst}`)

try { await initMapspinnerRender(gl, {}) } catch (_) {}
const afterSecond = await settleTextureFetches(afterFirst)
expect('rejected decode is retried on the next call', afterSecond > afterFirst, `fetches before=${afterFirst} after=${afterSecond}`)

const passed = checks.every(Boolean)
console.log(`RESULT: ${passed ? 'PASS' : 'FAIL'} (${checks.filter(Boolean).length}/${checks.length} checks)`)
await exitAfterQuiesce(passed ? 0 : 1)
