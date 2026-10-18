#!/usr/bin/env node
// Witnesses that a refused placement window is terminal in the live createMinimapHUD.
//
// createPlacementScanner().begin() refuses (returns null) when its input contract is broken. A refused
// refresh must not count as a finished one: no terrain pass, no layer swap, no glyph paint.
//
// Live path: createMinimapHUD is driven through its update() with a DOM stand-in (canvas contexts
// that count every call, document, window, Image). Nothing is mocked inside the HUD itself.
//   refused arm: window.__app is absent, so readWorldSources yields no vegetation and no seed is
//                published, so begin() is handed worldSeed null and refuses.
//   valid arm:   window.__app.vegetation carries cfg.seed, so begin() arms and the window runs.
// The refused arm asserts zero terrain writes and zero overlay draws across many frames. The valid
// arm asserts the window is actually reached (terrain writes > 0), so the refused zero is not vacuous.
//
// Usage: node scripts/minimap-refresh-refusal-witness.mjs [--module=<path to MinimapHUD.js>]
import Module from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = pathToFileURL(`${REPO}/`).href
const mapSrc = (specifier) => (specifier.startsWith('/src/') ? new URL(specifier.slice(1), REPO_URL).href : null)
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = mapSrc(specifier)
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
    },
  })
} else {
  console.log('RESULT: FAIL (uncaught) -- this node has no module.registerHooks, so /src/ specifiers cannot resolve')
  process.exit(1)
}

const argv = process.argv.slice(2)
const modArg = argv.find(a => a.startsWith('--module='))
const MODULE_PATH = modArg ? resolve(modArg.slice('--module='.length)) : `${REPO}/client/hud/MinimapHUD.js`
// The valid window must finish its terrain pass before it can paint, and that pass is seconds of
// real sampling, so each arm runs for a wall-clock budget. The refused arm gets the same budget: a
// refusal that only looks clean because the run ended early would prove nothing.
const BUDGET_MS = Number(process.env.MINIMAP_REFUSAL_BUDGET_MS || 20000)
const QUIET = 300

// ---- DOM stand-in: every canvas context counts the calls made on it ----
const counts = new Map()
function countingContext(label, width) {
  const tally = { width }
  counts.set(label, tally)
  return new Proxy({}, {
    get(_t, key) {
      if (key === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      if (key === 'getImageData') return (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      if (key === 'canvas') return null
      return (...args) => { tally[key] = (tally[key] || 0) + 1; return args.length ? undefined : undefined }
    },
    set() { return true },
  })
}
const total = (label, names) => names.reduce((n, k) => n + ((counts.get(label) || {})[k] || 0), 0)

class StubElement {
  constructor(tag) { this.tagName = tag; this.style = {}; this.children = []; this.id = ''; this.textContent = '' }
  appendChild(c) { this.children.push(c); return c }
  getContext() { return this._ctx || (this._ctx = countingContext(this._label || (this._label = `canvas#${++canvasSeq}`), this.width)) }
}
let canvasSeq = 0
const body = new StubElement('body')
const head = new StubElement('head')
globalThis.document = {
  createElement: (tag) => new StubElement(tag),
  getElementById: () => null,
  body,
  head,
}
globalThis.window = { devicePixelRatio: 1, __app: null, __terrain: null, __floatingOrigin: null }
globalThis.Image = class { set src(_v) {} }

const { createMinimapHUD } = await import(pathToFileURL(MODULE_PATH).href)
const { loadWorldModule } = await import(pathToFileURL(`${REPO}/src/sdk/WorldLocator.js`).href)
const { resolveTerrainConfig } = await import(pathToFileURL(`${REPO}/src/shared/terrainConfig.js`).href)
const { loadPlanetSampler, planetSamplerOptsOf } = await import(pathToFileURL(`${REPO}/src/terrain/TerrainPhysics.js`).href)
const { createPlanetFrame } = await import(pathToFileURL(`${REPO}/src/terrain/PlanetFrame.js`).href)
const { SPECIES } = await import(pathToFileURL(`${REPO}/src/terrain/VegPlacement.js`).href)
const { createBiomeOverride } = await import(pathToFileURL(`${REPO}/src/terrain/BiomeOverride.js`).href)
const loaded = await loadWorldModule(`${REPO}/apps/world/tps-game.js`)
const tcfg = resolveTerrainConfig(loaded)
const SEED = tcfg.seed | 0
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = sampler.anchorField

// Terrain writes are putImageData calls on a layer's terrain canvas: finishTerrain is the only place
// the HUD writes one, and it runs once per refresh that reaches the terrain phase.
const terrainWrites = () => {
  let n = 0
  for (const [label, tally] of counts) if (label && tally.putImageData) n += tally.putImageData
  return n
}
// Glyph paint lands on the overlay layers (width SIZE_PX * dpr * BUFFER_OVER_VIEW = 252); the main
// canvas (168) draws the HUD chrome and the arrow on every frame, so it is excluded.
const OVERLAY_PX = 252
const overlayDraws = () => {
  let n = 0
  for (const [, tally] of counts) {
    if (tally.width !== OVERLAY_PX) continue
    for (const k of Object.keys(tally)) if (k !== 'width') n += tally[k]
  }
  return n
}

const minimapMeta = { base: '/nonexistent/minimap', center: [0, 0], extent: 4096 }
const getPose = () => ({ x: 10, z: 10, yaw: 0 })
let activeFrame = frame
const getTerrain = () => ({ frame: activeFrame, sampler: { anchorField } })

const outcomes = []
const check = (name, ok, detail) => outcomes.push({ name, ok, detail })

// Every terrain cell the HUD samples goes through frame.groundHeightLocal. The probe counts those
// calls and forwards them to the real frame, so a refused window that still runs its terrain phase
// shows up as sampler calls, whatever the wall-clock of the pass.
function probeFrame() {
  const probe = { calls: 0 }
  const view = new Proxy(frame, {
    get(target, key) {
      const v = target[key]
      if (key !== 'groundHeightLocal' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v
      return (...args) => { probe.calls++; return v.apply(target, args) }
    },
  })
  return { view, probe }
}

// Runs update() for BUDGET_MS of wall clock with the given sources and returns what the HUD did.
function run(setup) {
  counts.clear()
  canvasSeq = 0
  globalThis.window.__app = null
  globalThis.window.__terrain = null
  setup()
  const { view, probe } = probeFrame()
  activeFrame = view
  const hud = createMinimapHUD(minimapMeta, getPose, getTerrain)
  let thrown = null
  const t0 = performance.now()
  let frames = 0
  try {
    while (performance.now() - t0 < BUDGET_MS) {
      hud.update()
      frames++
    }
  } catch (e) {
    thrown = e
  }
  return { thrown, frames, samplerCalls: probe.calls, writes: terrainWrites(), draws: overlayDraws(), view }
}

// refused arm: no vegetation source and no published seed, so begin refuses on worldSeed null.
const refused = run(() => {})
check('refused arm: the HUD ran without throwing', refused.thrown === null, refused.thrown && refused.thrown.message)
check('refused arm: zero terrain cells sampled (a refused window runs no terrain pass)', refused.samplerCalls === 0, `groundHeightLocal calls ${refused.samplerCalls} over ${refused.frames} frames`)
check('refused arm: zero terrain writes and zero overlay draws', refused.writes === 0 && refused.draws === 0, `terrain writes ${refused.writes}, overlay draws ${refused.draws}`)

// valid arm: a seed is published and a vegetation source exists, so the window arms and samples.
const valid = run(() => {
  globalThis.window.__app = { vegetation: { cfg: { seed: SEED }, _meshes: SPECIES.map(name => ({ name })), biomeOverride: createBiomeOverride([]) }, rocks: {} }
})
check('valid arm: the HUD ran without throwing', valid.thrown === null, valid.thrown && valid.thrown.message)
check('valid arm: the window is armed and samples terrain (groundHeightLocal calls > 0), so the refused zero is not vacuous', valid.samplerCalls > 0, `groundHeightLocal calls ${valid.samplerCalls} over ${valid.frames} frames`)

const failed = outcomes.filter(o => !o.ok)
for (const o of outcomes) console.log(`${o.ok ? 'ok  ' : 'FAIL'} ${o.name}${o.detail ? ` -- ${o.detail}` : ''}`)
console.log(`module ${MODULE_PATH}`)
console.log(`${outcomes.length - failed.length} of ${outcomes.length} checks passed`)
console.log(failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL -- ${failed.length} of ${outcomes.length} checks failed`)
process.exit(failed.length === 0 ? 0 : 1)
