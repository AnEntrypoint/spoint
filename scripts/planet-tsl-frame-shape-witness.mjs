import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tokenize } from './lib/js-token-stream.mjs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = path.join(ROOT, 'packages/mapspinner/src/tsl/planet-tsl.js')
const HPF_FAILURE_CODE = 'HPF_WORKER_FAILED'
const BOOT_TIMEOUT_MS = 90000
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])

const failures = []
function check(label, ok, detail) {
  console.log(`[planet-tsl-frame-shape] ${label}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(label)
}

function splitTopLevel(tokens, from, to, separator) {
  const parts = [[]]
  let depth = 0
  for (let i = from; i < to; i++) {
    const t = tokens[i]
    if (OPEN.has(t.text)) depth++
    else if (CLOSE.has(t.text)) depth--
    if (depth === 0 && t.text === separator) parts.push([])
    else parts[parts.length - 1].push(t)
  }
  return parts.filter((p) => p.length > 0)
}

function frameReturnProperties(source) {
  const { tokens } = tokenize(source)
  const fnAt = tokens.findIndex((t, i) => t.text === 'function' && tokens[i + 1]?.text === 'frame' && tokens[i + 2]?.text === '(')
  if (fnAt < 0) return null
  let i = fnAt + 2
  let depth = 0
  for (; i < tokens.length; i++) {
    if (OPEN.has(tokens[i].text)) depth++
    else if (CLOSE.has(tokens[i].text)) depth--
    if (depth === 0) break
  }
  const bodyOpen = tokens.findIndex((t, j) => j > i && t.text === '{')
  let end = bodyOpen
  depth = 0
  for (; end < tokens.length; end++) {
    if (OPEN.has(tokens[end].text)) depth++
    else if (CLOSE.has(tokens[end].text)) depth--
    if (depth === 0) break
  }
  let depthHere = 0
  let retAt = -1
  for (let j = bodyOpen + 1; j < end; j++) {
    const t = tokens[j]
    if (OPEN.has(t.text)) depthHere++
    else if (CLOSE.has(t.text)) depthHere--
    if (depthHere === 0 && t.text === 'return' && tokens[j + 1]?.text === '{') { retAt = j + 1; break }
  }
  if (retAt < 0) return null
  let close = retAt
  depth = 0
  for (; close < end; close++) {
    if (OPEN.has(tokens[close].text)) depth++
    else if (CLOSE.has(tokens[close].text)) depth--
    if (depth === 0) break
  }
  return splitTopLevel(tokens, retAt + 1, close, ',').map((prop) => {
    const colon = prop.findIndex((t) => t.text === ':')
    if (colon < 0) return { key: prop[0].text, value: prop[0].text }
    const key = prop.slice(0, colon).map((t) => t.text).join('')
    const value = prop.slice(colon + 1).map((t) => t.text).join('')
    return { key, value }
  })
}

const props = frameReturnProperties(readFileSync(MODULE, 'utf8'))

check('frame() return object located', Array.isArray(props) && props.length > 0)
if (props) {
  const counts = new Map()
  for (const p of props) counts.set(p.key, (counts.get(p.key) || 0) + 1)
  const dupes = [...counts].filter(([, n]) => n > 1).map(([k]) => k)
  check('frame() return keys are unique', dupes.length === 0, dupes.length ? `duplicated: ${dupes.join(',')}` : `${props.length} keys`)
  const planKeys = props.filter((p) => p.value === 'lastNear').map((p) => p.key)
  const planeKeys = props.filter((p) => p.value === 'nf.near').map((p) => p.key)
  check('near plan record still returned under one key', planKeys.length === 1, `keys=${planKeys.join(',') || 'none'}`)
  check('near-plane number still returned under one key', planeKeys.length === 1, `keys=${planeKeys.join(',') || 'none'}`)
  check('plan record and near plane have distinct keys', planKeys.length === 1 && planeKeys.length === 1 && planKeys[0] !== planeKeys[0], '')
}

class FailingWorker {
  constructor(url) {
    this.url = String(url)
    setTimeout(() => this.onerror?.({ message: 'stub worker failure' }), 0)
  }
  postMessage() {}
  terminate() {}
}
globalThis.Worker = FailingWorker

const hooks = await installSpecifierHooks()
const mod = await import(pathToFileURL(MODULE).href)
const renderer = { isWebGPURenderer: true, domElement: { width: 1, height: 1 } }
const scene = { add() {}, remove() {}, backgroundNode: null }

let outcome
try {
  const boot = mod.initMapspinnerPlanetTSL(renderer, scene, { loadSurfaceTextures: false, water: false, sky: false })
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('boot timed out')), BOOT_TIMEOUT_MS) })
  await Promise.race([boot, timeout]).finally(() => clearTimeout(timer))
  outcome = { resolved: true }
} catch (e) {
  outcome = { resolved: false, code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e) }
}
console.log(`[planet-tsl-frame-shape] specifier hooks: ${hooks}; boot outcome with a failing HPF worker: ${JSON.stringify(outcome)}`)
check('HPF worker failure is thrown as a coded error', outcome.code === HPF_FAILURE_CODE, `code=${outcome.code} name=${outcome.name}`)

if (failures.length) {
  console.log(`RESULT: FAIL (${failures.length} check(s): ${failures.join('; ')})`)
  process.exit(1)
}
console.log('RESULT: PASS')
process.exit(0)
