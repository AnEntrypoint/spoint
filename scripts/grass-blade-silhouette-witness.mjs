#!/usr/bin/env node
// Grass blade silhouette witness (gpu-free).
//
// Owner report: "the grass looks weird like its been made too narrow" / "grass scale is very small
// right now like its been scaled down". A blade card that TURNS has to be measured, not eyeballed,
// because the same geometry reads at a different width the moment its orientation changes: a card
// seen face-on presents its full width, the same card seen edge-on presents none.
//
// So this witness takes the real shipped clump geometry (makeClumpGeo -- the actual cards, at their
// actual angles, at their actual width and height), and measures what the camera gets:
//
//   * the projected silhouette width of one clump, summed over its cards, over a full turn of view
//     azimuths -- and the same for the three orientations the code can put it in: FIXED (the
//     pre-change shader never turned a clump at all), AXIS-TO-CAMERA and NORMAL-TO-CAMERA (the two
//     ways a clump can be turned to the camera: by its in-plane axis, or by its normal).
//   * the height, which no orientation changes, and the aspect ratio (width / height) that carries
//     both.
//   * which of those two turnings THE SHIPPED SHADER ACTUALLY INSTALLS, read out of
//     client/core/GrassTSL.js and client/core/GrassMaterial.js -- never assumed.
//
// A clump whose cards all lie along the direction to the camera is edge-on to it, so this witness is
// the instrument that can tell "the card shrank" from "an unchanged card turned".
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CANVAS_CTX = () => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }),
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: CANVAS_CTX }) }
globalThis.Image = class { set src(v) {} }
await installSpecifierHooks()
const { makeClumpGeo } = await import(pathToFileURL(resolve(ROOT, 'client', 'core', 'GrassClump.js')).href)

const TSL_SRC = readFileSync(resolve(ROOT, 'client/core/GrassTSL.js'), 'utf8')
const GLSL_SRC = readFileSync(resolve(ROOT, 'client/core/GrassMaterial.js'), 'utf8')

// One clump, as the grass LODs actually build it: the near LOD and the mid LOD.
const geo = makeClumpGeo(3, 3)
const pos = geo.getAttribute('position').array
const bb = geo.boundingBox
const cardWidth = bb.max.x - bb.min.x   // not the silhouette: the geometry's own extent
const cardHeight = bb.max.y - bb.min.y
const cardDepth = bb.max.z - bb.min.z
console.log(`[grass-silhouette] shipped clump geometry: ${geo.getAttribute('position').count} vertex/vertices, ` +
  `${geo.index.count / 3} triangle(s), extent x=${cardWidth.toFixed(4)} y=${cardHeight.toFixed(4)} z=${cardDepth.toFixed(4)}`)

// The cards' own in-plane horizontal axes, measured out of the geometry: every card is a strip whose
// two columns of vertices run along one horizontal direction from the origin.
const cards = []
{
  const byRun = new Map()
  const n = geo.getAttribute('position').count
  for (let i = 0; i < n; i += 2) {
    // each row of the strip: two vertices at u = -0.5 and u = +0.5
    const ax = pos[i * 3], az = pos[i * 3 + 2]
    const bx = pos[(i + 1) * 3], bz = pos[(i + 1) * 3 + 2]
    const dx = bx - ax, dz = bz - az
    const len = Math.hypot(dx, dz)
    if (len < 1e-9) continue
    // the card's horizontal axis, and its width along it
    let th = Math.atan2(dz, dx)
    if (th < 0) th += Math.PI
    const key = th.toFixed(3)
    const rec = byRun.get(key) || { theta: th, width: 0, rows: 0 }
    rec.width = Math.max(rec.width, len)
    rec.rows++
    byRun.set(key, rec)
  }
  for (const rec of byRun.values()) cards.push(rec)
}
console.log(`[grass-silhouette] ${cards.length} card(s) measured out of the geometry: ` +
  cards.map((c) => `${(c.theta * 180 / Math.PI).toFixed(1)}deg w=${c.width.toFixed(3)}`).join(', '))

// Apparent width of one card whose in-plane horizontal axis is theta, seen from a camera at azimuth
// phi: the card's plane contains theta and the vertical, so it presents |sin(theta - phi)| of its
// width -- 1 face-on, 0 edge-on. The clump's silhouette is the union of its cards, whose width is
// what the eye reads, so the silhouette is the sum over cards (they overlap in depth, not in width).
const silhouette = (theta0, phi) => cards.reduce((a, c) => a + c.width * Math.abs(Math.sin((c.theta + theta0) - phi)), 0)

// A card's normal is its axis turned a quarter turn, so "turn the clump to the camera" has two
// possible meanings and only one of them faces it.
const SAMPLES = 720
const stat = (fn) => {
  let sum = 0, min = Infinity, max = -Infinity
  for (let i = 0; i < SAMPLES; i++) {
    const phi = (i / SAMPLES) * 2 * Math.PI
    const v = fn(phi)
    sum += v; if (v < min) min = v; if (v > max) max = v
  }
  return { mean: sum / SAMPLES, min, max }
}
// FIXED: the clump keeps the yaw it was instanced with, whatever the camera does (the pre-change
// shader never turned a clump, so every view azimuth is equally likely).
const fixed = stat((phi) => silhouette(0, phi))
// AXIS-TO-CAMERA: the clump's own axis (the local +X the shader rotates) is turned onto the
// direction to the camera. Card 0 then points AT the camera, so card 0 is edge-on.
const axisToCam = stat((phi) => { const theta0 = phi - cards[0].theta; return silhouette(theta0, phi) })
// NORMAL-TO-CAMERA: the clump's axis is turned a quarter turn from the direction to the camera, so
// its normal -- and therefore card 0's face -- points at the camera.
const normalToCam = stat((phi) => { const theta0 = phi - cards[0].theta + Math.PI / 2; return silhouette(theta0, phi) })

const H = cardHeight
const row = (label, s) => `${label}: width mean ${s.mean.toFixed(3)} min ${s.min.toFixed(3)} max ${s.max.toFixed(3)}` +
  ` | height ${H.toFixed(3)} | aspect mean ${(s.mean / H).toFixed(3)} worst ${(s.min / H).toFixed(3)}`
console.log('[grass-silhouette] ' + row('FIXED (no turning)', fixed))
console.log('[grass-silhouette] ' + row('AXIS-TO-CAMERA', axisToCam))
console.log('[grass-silhouette] ' + row('NORMAL-TO-CAMERA', normalToCam))

// Which turning does the shipped shader install? gTarget is the direction the clump's axis (gAxis,
// the instance's local +X) is turned onto; if it is the direction TO the camera the cards go
// edge-on, if it is that direction turned a quarter turn they face the camera.
const hasPerp = (src) => /gToCam\.y\.negate\(\)|vec2\(\s*gToCam\.y\.negate|perp|gPerp/.test(src)
const axisBasis = /gTarget\s*=\s*gToCam\.mul/.test(TSL_SRC)
const glslAxisBasis = /gTarget\s*=\s*gToCam\s*\*/.test(GLSL_SRC)
const tslPerp = hasPerp(TSL_SRC), glslPerp = hasPerp(GLSL_SRC)
const basis = (tslPerp || glslPerp) ? 'NORMAL-TO-CAMERA' : ((axisBasis || glslAxisBasis) ? 'AXIS-TO-CAMERA' : 'UNKNOWN')
console.log(`[grass-silhouette] shipped turning: ${basis} (TSL perpendicular=${tslPerp} axisForm=${axisBasis}, GLSL perpendicular=${glslPerp} axisForm=${glslAxisBasis})`)

const shipped = basis === 'NORMAL-TO-CAMERA' ? normalToCam : (basis === 'AXIS-TO-CAMERA' ? axisToCam : null)
let failed = 0
const expect = (name, ok, detail) => { console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + ': ' + detail); if (!ok) failed++ }

expect('the shipped turning is one this instrument can name', shipped !== null,
  `client/core/GrassTSL.js and client/core/GrassMaterial.js install ${basis}`)

// The second way a blade reads narrower than it is: the per-blade fade multiplies the whole card,
// width included, where the ring fade it replaced squashed height alone. Measured in the browser arm
// (grass-density-fade-visual-witness, mean per-blade scale by band) the mid band carried 0.718 and
// the far band 0.768 of a blade's width as well as of its height.
const fadeWholeCard = /transformed\.mulAssign\(gIn/.test(TSL_SRC) || /transformed \*= gIn/.test(GLSL_SRC)
const fadeHeightOnly = /transformed\.y\.mulAssign\(gIn\)/.test(TSL_SRC) && /transformed\.y \*= gIn/.test(GLSL_SRC)
expect('the fade takes a blade to zero in height and leaves its width alone',
  fadeHeightOnly && !fadeWholeCard,
  `GrassTSL.js height-only=${fadeHeightOnly}, whole-card=${fadeWholeCard}; the whole-card form is what made a field of full-width blades read as a field of narrow ones`)
if (shipped) {
  // Turning a clump to the camera must not buy its readability by narrowing it: a card that faces
  // the camera is the widest presentation of that card there is.
  expect('turning a clump to the camera does not narrow it',
    shipped.mean >= fixed.mean - 1e-9,
    `shipped ${basis} width mean ${shipped.mean.toFixed(3)} vs the same clump never turned ${fixed.mean.toFixed(3)} ` +
    `(the other turning reads ${(basis === 'AXIS-TO-CAMERA' ? normalToCam.mean : axisToCam.mean).toFixed(3)})`)
  expect('no view azimuth leaves the clump narrower than every card but one',
    shipped.min >= cards.reduce((a, c) => Math.min(a, c.width), Infinity) * 0.999,
    `worst azimuth reads ${shipped.min.toFixed(3)} of silhouette, the narrowest single card is ${Math.min(...cards.map((c) => c.width)).toFixed(3)}`)
}
console.log(`[grass-silhouette] MEASURED grass-silhouette: shipped=${basis} width ${shipped ? shipped.mean.toFixed(3) : 'n/a'} ` +
  `(min ${shipped ? shipped.min.toFixed(3) : 'n/a'}) vs fixed ${fixed.mean.toFixed(3)} (min ${fixed.min.toFixed(3)}), ` +
  `height ${H.toFixed(3)}, aspect ${shipped ? (shipped.mean / H).toFixed(3) : 'n/a'} vs ${(fixed.mean / H).toFixed(3)}, cards=${cards.length}`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} -- grass-silhouette: ${cards.length} card(s), shipped turning ${basis}, ` +
  `silhouette width ${shipped ? shipped.mean.toFixed(3) : 'n/a'} against ${fixed.mean.toFixed(3)} never turned and ` +
  `${normalToCam.mean.toFixed(3)} turned face-on, height ${H.toFixed(3)} unchanged by any turning`)
process.exit(failed ? 1 : 0)
