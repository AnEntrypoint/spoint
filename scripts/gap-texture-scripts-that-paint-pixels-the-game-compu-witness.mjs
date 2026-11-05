import { paintTexture } from '../src/procgen/TextureScript.js'

let failures = 0
function expect(label, ok, detail = '') {
  if (ok) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label} ${detail}`)
  }
}

function throwsWith(fn, fragment) {
  try {
    fn()
    return { threw: false, message: '' }
  } catch (err) {
    return { threw: true, message: String(err.message), matches: String(err.message).includes(fragment) }
  }
}

const solid = paintTexture({ width: 8, height: 4, paint: () => [10, 20, 30, 255] })
expect('buffer length is width*height*4', solid.pixels.length === 8 * 4 * 4, `got ${solid.pixels.length}`)
expect('solid paint fills every pixel', solid.pixels.every((v, i) => v === [10, 20, 30, 255][i % 4]))

const grad = paintTexture({ width: 5, height: 3, paint: (x, y, u, v) => [Math.round(u * 255), Math.round(v * 255), 0, 255] })
const at = (x, y, c) => grad.pixels[(y * 5 + x) * 4 + c]
expect('u runs 0..1 across the row', at(0, 0, 0) === 0 && at(4, 0, 0) === 255, `${at(0, 0, 0)} ${at(4, 0, 0)}`)
expect('v runs 0..1 down the column', at(0, 0, 1) === 0 && at(0, 2, 1) === 255, `${at(0, 0, 1)} ${at(0, 2, 1)}`)

const noisePaint = (x, y, u, v, noise) => {
  const n = (noise(x * 0.3, y * 0.3) + 1) * 127.5
  return [n, n, n, 255]
}
const a1 = paintTexture({ width: 16, height: 16, seed: 7, paint: noisePaint })
const a2 = paintTexture({ width: 16, height: 16, seed: 7, paint: noisePaint })
const b1 = paintTexture({ width: 16, height: 16, seed: 8, paint: noisePaint })
expect('same seed gives identical pixels', a1.pixels.every((v, i) => v === a2.pixels[i]))
expect('different seed gives different pixels', a1.pixels.some((v, i) => v !== b1.pixels[i]))
expect('noise channel is clamped into 0..255', a1.pixels.every((v) => v >= 0 && v <= 255))

const w0 = throwsWith(() => paintTexture({ width: 0, height: 4, paint: () => [0, 0, 0, 0] }), 'width must be a positive integer')
expect('zero width is refused', w0.threw && w0.matches, w0.message)
const h1 = throwsWith(() => paintTexture({ width: 4, height: 1.5, paint: () => [0, 0, 0, 0] }), 'height must be a positive integer')
expect('fractional height is refused', h1.threw && h1.matches, h1.message)
const p0 = throwsWith(() => paintTexture({ width: 4, height: 4 }), 'paint must be a function')
expect('missing paint is refused', p0.threw && p0.matches, p0.message)
const s0 = throwsWith(() => paintTexture({ width: 4, height: 4, seed: 1.5, paint: () => [0, 0, 0, 0] }), 'seed must be an integer')
expect('non-integer seed is refused', s0.threw && s0.matches, s0.message)
const c0 = throwsWith(() => paintTexture({ width: 2, height: 2, paint: () => [0, 0, 0] }), 'must return [r, g, b, a]')
expect('short pixel is refused', c0.threw && c0.matches, c0.message)
const c1 = throwsWith(() => paintTexture({ width: 2, height: 2, paint: (x) => [x === 1 ? NaN : 0, 0, 0, 0] }), 'not a finite number')
expect('NaN channel is refused, not clamped to 0', c1.threw && c1.matches, c1.message)
const c2 = throwsWith(() => paintTexture({ width: 2, height: 2, paint: () => '0000' }), 'must return [r, g, b, a]')
expect('non-array pixel is refused', c2.threw && c2.matches, c2.message)

if (failures === 0) {
  console.log('RESULT: PASS')
  process.exit(0)
}
console.log(`RESULT: FAIL ${failures}`)
process.exit(1)
