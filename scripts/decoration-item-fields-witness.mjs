import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parseDecorationDef, DecorationConfigError } = await import('../src/terrain/DecorationLayers.js')

const decor = parseDecorationDef({
  layers: {
    fern: { itemsPerM2: 3, item: { kind: 'sprite', sprite: 'fern.png' } },
    grassTuft: { itemsPerM2: 50, item: { kind: 'scripted', script: 'tuft.js' } },
    bare: { itemsPerM2: 1 },
  },
})
assert.deepEqual(decor.layers.get('fern').item, { kind: 'sprite', ref: 'fern.png' })
assert.deepEqual(decor.layers.get('grassTuft').item, { kind: 'scripted', ref: 'tuft.js' })
assert.equal(decor.layers.get('bare').item, null, 'a layer without an item keeps item null')

for (const [item, reason] of [
  [{ kind: 'mesh' }, 'badItem'],
  [{ kind: 'sprite', sprite: '' }, 'badItem'],
  [{ kind: 'scripted' }, 'badItem'],
  ['fern.png', 'badItem'],
]) assert.throws(() => parseDecorationDef({ layers: { x: { itemsPerM2: 1, item } } }), e => e instanceof DecorationConfigError && e.reasonCode === reason, JSON.stringify(item))

console.log('RESULT: PASS decoration layers take a sprite or scripted item reference; a missing or unknown item kind, an empty reference and a non-object item refuse with badItem')
