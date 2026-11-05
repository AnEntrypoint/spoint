import { atlasLayout, AtlasSpecError } from '../src/sdk/TextureAtlas.js'

let passed = 0
let failed = 0
function expect(label, ok) {
  if (ok) passed++
  else failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
function refuses(spec, code) {
  try {
    atlasLayout(spec)
    return false
  } catch (err) {
    return err instanceof AtlasSpecError && err.reasonCode === code
  }
}

const hero = atlasLayout({ frameSize: [32, 40], animations: { idle: 2, walk: 4 }, columns: 4 })
expect('sheet size is columns x frame size', hero.width === 128 && hero.height === 80)
expect('rows derived from frame total', hero.rows === 2)
expect('walk clip starts after idle', hero.clips.walk.start === 2 && hero.clips.walk.count === 4)
expect('walk cell 3 wraps to second row', JSON.stringify(hero.clips.walk.cells[2]) === '[0,40]')
expect('idle cell 1 sits at x=32', JSON.stringify(hero.clips.idle.cells[1]) === '[32,0]')

const single = atlasLayout({ frameSize: [16, 8], animations: { hop: 3 } })
expect('columns default to total frames', single.columns === 3 && single.rows === 1 && single.width === 48)

expect('refuses non-object spec', refuses(null, 'spec-not-object'))
expect('refuses zero frame width', refuses({ frameSize: [0, 8], animations: { a: 1 } }, 'frame-size-invalid'))
expect('refuses fractional frame height', refuses({ frameSize: [8, 8.5], animations: { a: 1 } }, 'frame-size-invalid'))
expect('refuses numeric-string frame count', refuses({ frameSize: [8, 8], animations: { a: '2' } }, 'frame-count-invalid'))
expect('refuses empty animations', refuses({ frameSize: [8, 8], animations: {} }, 'animations-empty'))
expect('refuses bad columns', refuses({ frameSize: [8, 8], animations: { a: 2 }, columns: 0 }, 'columns-invalid'))

const failures = failed
console.log(`${passed} passed, ${failures} failed`)
if (failures === 0) console.log('RESULT: PASS')
process.exit(failures === 0 ? 0 : 1)
