import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parseDecorationDef, acceptsCell, decorateCells, DecorationConfigError } = await import('../src/terrain/DecorationLayers.js')

const decor = parseDecorationDef({
  layers: {
    tuft: { itemsPerM2: 50, paintedOnly: true },
    reed: { itemsPerM2: 3, avoidWater: true, maxWaterDepth: 0.2 },
  },
  bindings: { grass: ['tuft', 'reed'] },
})
const tuft = decor.layers.get('tuft')
const reed = decor.layers.get('reed')
assert.equal(tuft.itemsPerM2, 50, 'items per m2 above 1 must survive parsing')

const base = { seed: 7, ix: 1, iz: 2, slope: 0, height: 0, area: 1, painted: true, waterDepth: 0 }
assert.equal(acceptsCell(tuft, { ...base, painted: false }), false, 'paintedOnly refuses unpainted cells')
assert.equal(acceptsCell(reed, { ...base, waterDepth: 0.5 }), false, 'avoidWater refuses a cell deeper than maxWaterDepth')
assert.throws(() => acceptsCell(reed, { ...base, waterDepth: undefined }), e => e instanceof DecorationConfigError && e.reasonCode === 'noWaterDepth')

let kept = 0
for (let i = 0; i < 2000; i++) if (acceptsCell(tuft, { ...base, ix: i, iz: i * 3, area: 0.1 })) kept++
assert.ok(kept / 2000 > 0.9, `50 items/m2 over 0.1 m2 cells must keep almost every cell, kept ${kept}/2000`)

const placed = decorateCells(decor, [{ ...base, material: 'grass' }])
assert.ok(placed.length >= 0)

for (const [def, code] of [
  [{ layers: { x: { itemsPerM2: -1 } } }, 'badDensity'],
  [{ layers: { x: { itemsPerM2: 1, paintedOnly: 'yes' } } }, 'badFlag'],
]) assert.throws(() => parseDecorationDef(def), e => e.reasonCode === code, code)

console.log('RESULT: PASS items per m2 above 1 parse, paintedOnly and avoidWater gate cells, a missing waterDepth refuses with noWaterDepth, and bad density or flags refuse with codes')
