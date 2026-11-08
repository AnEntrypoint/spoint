import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PANEL = path.join(ROOT, 'packages/mapspinner/src/tweak-panel.js')
const SPLAT = path.join(ROOT, 'packages/mapspinner/src/tsl/surface-splat-tsl.js')
const DEFAULTS = path.join(ROOT, 'packages/mapspinner/src/terrain-defaults.js')

const outcomes = []
const check = (name, ok, detail) => {
  outcomes.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

const mountRoot = []
const fakeElement = (tag) => ({ tagName: tag, style: {}, children: [], title: '', append(...nodes) { this.children.push(...nodes) }, appendChild(node) { this.children.push(node); return node } })
globalThis.window = globalThis
globalThis.document = {
  readyState: 'complete',
  getElementById: () => null,
  createElement: fakeElement,
  addEventListener() {},
  body: { append(...nodes) { mountRoot.push(...nodes) } },
}

await import(pathToFileURL(PANEL).href)
const { TERRAIN_DEFAULTS: TD } = await import(pathToFileURL(DEFAULTS).href)

const findRow = (node, title) => {
  if (node.children?.[0]?.title === title) return node
  for (const child of node.children ?? []) {
    const hit = findRow(child, title)
    if (hit) return hit
  }
  return null
}
const panel = mountRoot.find((node) => node.id === 'tweakPanel')
const texWarpRow = panel ? findRow(panel, 'window.__texWarp') : null
if (!texWarpRow) {
  check('texWarp row mounted', false, 'no slider row titled window.__texWarp was built by tweak-panel.js')
} else {
  const [, slider] = texWarpRow.children
  const min = Number(slider.min), max = Number(slider.max), shown = Number(slider.value)
  check('texWarp default inside slider range', Number.isFinite(shown) && shown >= min && shown <= max,
    `slider min=${min} max=${max} default=${shown} (TERRAIN_DEFAULTS.texWarp=${TD.texWarp})`)
}

const splat = await import(pathToFileURL(SPLAT).href)

window.__texMix = undefined
window.__texWarp = undefined
const mixDefault = splat.splatMix?.value
const warpDefault = splat.splatWarp?.value
check('splat mix uniform exported and defaults to TERRAIN_DEFAULTS.texMix',
  mixDefault === TD.texMix, `splatMix.value=${mixDefault} expected=${TD.texMix}`)
check('splat warp uniform exported and defaults to TERRAIN_DEFAULTS.texWarp',
  warpDefault === TD.texWarp, `splatWarp.value=${warpDefault} expected=${TD.texWarp}`)

window.__texMix = 0.35
window.__texWarp = 0.2
const mixLever = splat.splatMix?.value
const warpLever = splat.splatWarp?.value
check('texMix lever reaches splat TSL uniform', mixLever === 0.35, `window.__texMix=0.35 -> splatMix.value=${mixLever}`)
check('texWarp lever reaches splat TSL uniform', warpLever === 0.2, `window.__texWarp=0.2 -> splatWarp.value=${warpLever}`)

const pass = outcomes.every(Boolean) && outcomes.length > 0
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
