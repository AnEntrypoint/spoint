// Landscape-change frame spike: the longest synchronous block the main thread takes while the
// vegetation species for a new landscape are built.
//
// A frame is one macrotask as far as the main thread is concerned: while a synchronous call runs,
// nothing renders. So the synchronous duration of one buildSpecies() call IS a frame spike, and
// the 8 ms BUILD_SLICE_BUDGET_MS in client/core/Vegetation.js is only checked BETWEEN species --
// it cannot cut a single species that costs more than a frame.
//
// Instruments: main-thread synchronous block duration (not vsync-quantized) plus counted work
// units (species generated, geometries scaled, vertices touched). No per-pass GPU timings: they
// are invalid on this project.

import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = pathToFileURL(`${REPO}/`).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/src/')) return nextResolve(new URL(specifier.slice(1), REPO_URL).href, context)
    return nextResolve(specifier, context)
  },
})

// ez-tree's module body runs THREE.TextureLoader.load, which needs document.createElementNS for
// the img element. The load never completes here and no texture is ever read: this witness times
// geometry work, which is the whole synchronous block.
const _el = () => ({
  style: {}, src: '', width: 1, height: 1,
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, appendChild() {}, remove() {},
  getContext: () => null,
})
globalThis.document = {
  createElementNS: () => _el(), createElement: () => _el(),
  body: _el(), head: _el(), addEventListener() {}, getElementById: () => null,
}

const FRAME_BUDGET_MS = 16.67
const HITCH_MS = 100
const PASSED = []
const FAILED = []
function check(label, cond, detail) {
  if (cond) { PASSED.push(label); console.log('  [PASS] ' + label) }
  else { FAILED.push(label); console.log('  [FAIL] ' + label + (detail ? ' -- ' + detail : '')) }
}

function spanMs(label, step) {
  const entries = performance.getEntriesByName('boot:vegetation:' + label + ':' + step)
  return entries.length ? +entries[entries.length - 1].duration.toFixed(3) : null
}

async function main() {
  let Tree = null, TreePreset = null
  try {
    ;({ Tree, TreePreset } = await import('@dgreenheck/ez-tree'))
  } catch (e) {
    console.log('[veg-spike] RESULT: FAIL (uncaught) -- @dgreenheck/ez-tree did not import: ' + ((e && e.message) || e))
    process.exitCode = 1
    return
  }
  let VB = null
  try {
    VB = await import('../client/core/VegetationBuild.js')
  } catch (e) {
    console.log('[veg-spike] RESULT: FAIL (uncaught) -- VegetationBuild.js did not import: ' + ((e && e.message) || e))
    process.exitCode = 1
    return
  }
  const { buildSpecies, capGeo, simplifyGeo, TARGET_H } = VB
  const { macrotaskYield } = await import('../client/core/macrotaskYield.js')

  const names = Object.keys(TARGET_H)
  console.log('[veg-spike] species=' + names.length + ' frame budget=' + FRAME_BUDGET_MS +
    'ms hitch threshold=' + HITCH_MS + 'ms')

  // JIT warm-up on the two cheapest presets: the first species a cold run builds pays for the
  // whole module's compile, and reporting that as the landscape-change spike would be a lie.
  for (const warm of ['Aspen Small', 'Bush 2']) {
    const sp = buildSpecies(warm, Tree, 0, TreePreset)
    await capGeo(sp.branchGeo, 6000)
    await capGeo(sp.leafGeo, 1400)
  }

  const rows = []
  let vertices = 0
  let geometriesScaled = 0
  // The per-species sequence client/core/Vegetation.js runs, in order, with every await timed: an
  // async function whose only await resolves before the real work does is still one synchronous
  // block, and t1-t0 across the await is that block.
  for (const name of names) {
    const label = name + '#0'
    const blocks = []
    const step = async (phase, fn) => {
      const t0 = performance.now()
      const out = await fn()
      blocks.push({ phase, ms: +(performance.now() - t0).toFixed(3) })
      return out
    }
    let sp, branchGeo0, leafGeo0
    sp = await step('generate', () => buildSpecies(name, Tree, 0, TreePreset))
    branchGeo0 = await step('capGeo-branch', () => capGeo(sp.branchGeo, 6000))
    leafGeo0 = await step('capGeo-leaf', () => capGeo(sp.leafGeo, 1400))
    await step('simplify-branch-l1', () => simplifyGeo(branchGeo0, 0.28, false))
    await step('simplify-branch-l2', () => simplifyGeo(branchGeo0, 0.07, true))
    await step('simplify-leaf-l1', () => simplifyGeo(leafGeo0, 0.30, false))
    await step('simplify-leaf-l2', () => simplifyGeo(leafGeo0, 0.09, true))
    await step('simplify-branch-shadow', () => simplifyGeo(branchGeo0, 0.07, true))

    const bv = sp.branchGeo.getAttribute('position').count
    const lv = sp.leafGeo.getAttribute('position').count
    vertices += bv + lv
    geometriesScaled += 2
    const worstStep = blocks.reduce((a, b) => (b.ms > a.ms ? b : a))
    const row = {
      name,
      stepMs: Object.fromEntries(blocks.map(b => [b.phase, b.ms])),
      worstPhase: worstStep.phase,
      worstMs: worstStep.ms,
      speciesMs: +blocks.reduce((a, b) => a + b.ms, 0).toFixed(3),
      geoScaleMs: spanMs(label, 'geo-scale'),
      treePresetMs: spanMs(label, 'tree-preset'),
      verts: bv + lv,
    }
    rows.push(row)
    console.log('[veg-spike] ' + JSON.stringify(row))
    await macrotaskYield()
  }

  const worst = rows.reduce((a, b) => (b.worstMs > a.worstMs ? b : a))
  const overFrame = rows.filter(r => r.worstMs >= FRAME_BUDGET_MS).length
  const overHitch = rows.filter(r => r.worstMs >= HITCH_MS).length
  const stepTotals = {}
  for (const r of rows) for (const k of Object.keys(r.stepMs)) stepTotals[k] = +(stepTotals[k] || 0) + r.stepMs[k]
  const owningPhase = Object.keys(stepTotals).sort((a, b) => stepTotals[b] - stepTotals[a])[0]
  console.log('[veg-spike] worst species step: ' + JSON.stringify(worst))
  console.log('[veg-spike] phase totals (ms): ' + JSON.stringify(stepTotals))
  console.log('[veg-spike] work units: species=' + rows.length + ' geometriesScaled=' +
    geometriesScaled + ' vertices=' + vertices)
  console.log('[veg-spike] worst step per species over ' + FRAME_BUDGET_MS + 'ms=' + overFrame +
    ' over ' + HITCH_MS + 'ms=' + overHitch + ' of ' + rows.length)

  check('no single species step blocks the main thread for a whole frame',
    worst.worstMs < FRAME_BUDGET_MS, 'worst=' + worst.worstMs + 'ms (' + worst.name + '/' + worst.worstPhase + ')')
  check('no single species step blocks the main thread past the ' + HITCH_MS + 'ms hitch threshold',
    overHitch === 0, 'overHitch=' + overHitch)

  const worstMs = rows.map(r => r.worstMs).sort((a, b) => a - b)
  const median = worstMs[worstMs.length >> 1]
  console.log('[veg-spike] worst-step median across species: ' + median + 'ms')
  console.log('[veg-spike] ' + PASSED.length + ' passed, ' + FAILED.length + ' failed')
  console.log('[veg-spike] RESULT: ' + (FAILED.length ? 'FAIL' : 'PASS') +
    ' -- worst synchronous block ' + worst.worstMs + ' ms (' + worst.name + '/' + worst.worstPhase +
    '), ' + overFrame + '/' + rows.length + ' species over ' + FRAME_BUDGET_MS + 'ms, ' +
    overHitch + ' over ' + HITCH_MS + 'ms, spike owned by ' + owningPhase)
  process.exitCode = FAILED.length ? 1 : 0
}

main().catch((e) => {
  console.error('[veg-spike] RESULT: FAIL (uncaught)')
  console.error((e && e.stack) || e)
  process.exitCode = 1
})
