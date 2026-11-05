import { parseDecorationDef, decorateCells, acceptsCell, DecorationConfigError } from '../src/terrain/DecorationLayers.js'

let failures = 0
let checks = 0

function expect(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}

function refusedWith(fn, reasonCode) {
  try {
    fn()
    return false
  } catch (err) {
    return err instanceof DecorationConfigError && err.reasonCode === reasonCode
  }
}

const grid = []
for (let ix = 0; ix < 40; ix++) for (let iz = 0; iz < 40; iz++) {
  grid.push({ material: ix % 2 === 0 ? 'grass' : 'rock', ix, iz, seed: 7, slope: (iz % 10) / 10, height: ix / 4 })
}

const decor = parseDecorationDef({
  layers: {
    flower: { density: 0.5, constraints: { slopeRange: [0, 0.5] } },
    pebble: { density: 1, budget: 5 },
    none: { density: 0 },
  },
  bindings: { grass: ['flower', 'none'], rock: ['pebble'] },
})

expect('parse accepts a valid def', decor.layers.size === 3 && decor.bindings.get('grass').length === 2)
expect('refuses density outside [0,1]', refusedWith(() => parseDecorationDef({ layers: { a: { density: 1.5 } } }), 'badDensity'))
expect('refuses NaN density', refusedWith(() => parseDecorationDef({ layers: { a: { density: NaN } } }), 'badDensity'))
expect('refuses inverted slope range', refusedWith(() => parseDecorationDef({ layers: { a: { density: 0.5, constraints: { slopeRange: [1, 0] } } } }), 'badRange'))
expect('refuses non-integer budget', refusedWith(() => parseDecorationDef({ layers: { a: { density: 0.5, budget: 2.5 } } }), 'badBudget'))
expect('refuses binding to unknown layer', refusedWith(() => parseDecorationDef({ layers: {}, bindings: { grass: ['ghost'] } }), 'unknownLayer'))
expect('refuses non-array binding', refusedWith(() => parseDecorationDef({ layers: {}, bindings: { grass: 'flower' } }), 'badBinding'))

const placed = decorateCells(decor, grid)
expect('only bound materials receive layers', placed.every((p) => p.layer !== 'pebble' || grid[p.ix * 40 + p.iz].material === 'rock'))
expect('density 0 layer places nothing', placed.every((p) => p.layer !== 'none'))
expect('budget caps layer count', placed.filter((p) => p.layer === 'pebble').length === 5)
expect('slope constraint excludes steep cells', placed.filter((p) => p.layer === 'flower').every((p) => (p.iz % 10) / 10 <= 0.5))
expect('density 0.5 places a non-trivial share', (() => {
  const grass = grid.filter((c) => c.material === 'grass' && c.slope <= 0.5)
  const n = placed.filter((p) => p.layer === 'flower').length
  return n > grass.length * 0.3 && n < grass.length * 0.7
})(), `flower=${placed.filter((p) => p.layer === 'flower').length}`)
expect('placement is deterministic', JSON.stringify(decorateCells(decor, grid)) === JSON.stringify(placed))
expect('height range rejects out-of-range cell', (() => {
  const h = parseDecorationDef({ layers: { tall: { density: 1, constraints: { heightRange: [0, 2] } } } }).layers.get('tall')
  return acceptsCell(h, { seed: 1, ix: 0, iz: 0, slope: 0, height: 3 }) === false && acceptsCell(h, { seed: 1, ix: 0, iz: 0, slope: 0, height: 1 }) === true
})())

console.log(failures === 0 ? `RESULT: PASS -- ${checks} check(s) passed` : `RESULT: FAIL -- ${failures} of ${checks} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
