#!/usr/bin/env node
// Gpu-free arm of PERF-rain-over-grass: the part of "rain draws over grass" that is checkable
// without a renderer -- the draw-band ordering itself. The visual half lives in
// scripts/rain-over-grass-browser-witness.mjs, which reaches the browser surface and therefore
// rides behind SPOINT_GPU_WITNESS instead of this arm.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WATER_TRANSPARENT_DRAW_BAND,
  ROCKS_OPAQUE_DRAW_BAND,
  GRASS_TRANSPARENT_DRAW_BAND,
  FOLIAGE_OPAQUE_DRAW_BAND,
  FOLIAGE_IMPOSTOR_DRAW_BAND,
  WEATHER_DRAWS_OVER_FOLIAGE_BAND,
  TERRAIN_OPAQUE_DRAW_BAND,
  DECAL_OPAQUE_DRAW_BAND,
  DECAL_BLEND_DRAW_BAND,
} from '../client/core/drawBands.js'

const LABEL = 'rain-over-grass-draw-order'
const LF = String.fromCharCode(10)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const OPS = {
  '==': (got, want) => Object.is(got, want),
  '>': (got, want) => typeof got === 'number' && Number.isFinite(got) && got > want,
  '<': (got, want) => typeof got === 'number' && Number.isFinite(got) && got < want,
}

const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}

function source(rel) { return readFileSync(resolve(REPO_ROOT, rel), 'utf8') }
function firstNumber(rel, re, label) {
  const hit = re.exec(source(rel))
  if (!hit) { expect(`${label} declares its value in ${rel}`, null, '==', 'found'); return NaN }
  return Number(hit[1])
}

const WEATHER = WEATHER_DRAWS_OVER_FOLIAGE_BAND

expect('weather band is above the grass band', WEATHER, '>', GRASS_TRANSPARENT_DRAW_BAND)
expect('weather band is above the foliage mesh band', WEATHER, '>', FOLIAGE_OPAQUE_DRAW_BAND)
expect('weather band is above the foliage impostor band', WEATHER, '>', FOLIAGE_IMPOSTOR_DRAW_BAND)
expect('weather band is above the rock band', WEATHER, '>', ROCKS_OPAQUE_DRAW_BAND)
expect('weather band is above the water band', WEATHER, '>', WATER_TRANSPARENT_DRAW_BAND)
expect('weather band is below the decal bands', WEATHER, '<', DECAL_OPAQUE_DRAW_BAND)
expect('weather band is below the decal blend band', WEATHER, '<', DECAL_BLEND_DRAW_BAND)

const OTHERS = [
  ['water', WATER_TRANSPARENT_DRAW_BAND],
  ['rocks', ROCKS_OPAQUE_DRAW_BAND],
  ['grass', GRASS_TRANSPARENT_DRAW_BAND],
  ['foliage-mesh', FOLIAGE_OPAQUE_DRAW_BAND],
  ['foliage-impostor', FOLIAGE_IMPOSTOR_DRAW_BAND],
  ['terrain', TERRAIN_OPAQUE_DRAW_BAND],
  ['decal', DECAL_OPAQUE_DRAW_BAND],
  ['decal-blend', DECAL_BLEND_DRAW_BAND],
]
for (const [name, band] of OTHERS) {
  expect(`weather band collides with no other band (${name}=${band})`, WEATHER === band, '==', false)
}

const weatherSrc = source('client/core/Weather.js')
const assignments = weatherSrc.match(/\bim(?:Splash|Snow|Far)?\.renderOrder = WEATHER_DRAWS_OVER_FOLIAGE_BAND\b/g) || []
expect('weather assigns the named band to its four meshes', assignments.length, '==', 4)
expect('weather sets no bare numeric renderOrder', /\brenderOrder = -?\d+\b/.test(weatherSrc), '==', false)

expect('shared grass band matches client/core/Grass.js', firstNumber('client/core/Grass.js', /\bim\.renderOrder = (-?\d+); imMid\.renderOrder = (-?\d+)/, 'grass'), '==', GRASS_TRANSPARENT_DRAW_BAND)
expect('shared rock band matches client/core/Rocks.js', firstNumber('client/core/Rocks.js', /const ROCKS_OPAQUE_DRAW_BAND = (-?\d+)/, 'rocks'), '==', ROCKS_OPAQUE_DRAW_BAND)
expect('shared foliage mesh band matches client/core/Vegetation.js', firstNumber('client/core/Vegetation.js', /const VEG_MESH_OPAQUE_DRAW_ORDER = (-?\d+)/, 'foliage mesh'), '==', FOLIAGE_OPAQUE_DRAW_BAND)
expect('shared foliage impostor band matches client/core/Vegetation.js', firstNumber('client/core/Vegetation.js', /const VEG_SHARED_IMPOSTOR_OPAQUE_DRAW_ORDER = (-?\d+)/, 'foliage impostor'), '==', FOLIAGE_IMPOSTOR_DRAW_BAND)
expect('shared terrain band matches the mapspinner planet module', firstNumber('packages/mapspinner/src/tsl/planet-tsl.js', /const TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS = (-?\d+)/, 'terrain'), '==', TERRAIN_OPAQUE_DRAW_BAND)
expect('shared water band matches the mapspinner planet module', firstNumber('packages/mapspinner/src/tsl/planet-tsl.js', /const WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS = (-?\d+)/, 'water'), '==', WATER_TRANSPARENT_DRAW_BAND)

const decalNumbers = [...source('client/core/DecalSystem.js').matchAll(/\bm\.renderOrder = (-?\d+)\b/g)].map((m) => Number(m[1]))
expect('shared decal bands match client/core/DecalSystem.js', JSON.stringify(decalNumbers), '==', JSON.stringify([DECAL_OPAQUE_DRAW_BAND, DECAL_BLEND_DRAW_BAND]))

for (const c of checks) console.log(`[${LABEL}] ${c.pass ? '[PASS]' : '[FAIL]'} ${c.label}: got ${JSON.stringify(c.got)} expected ${c.op} ${JSON.stringify(c.want)}`)
const failed = checks.filter((c) => !c.pass)
if (failed.length) {
  console.log(`RESULT: FAIL -- ${failed.length} of ${checks.length} check(s) failed: ${failed.map((c) => c.label).join('; ')}`)
  process.exit(1)
}
console.log(`RESULT: PASS (${checks.length}/${checks.length}) -- weather band ${WEATHER} sorts after grass ${GRASS_TRANSPARENT_DRAW_BAND} and foliage ${FOLIAGE_IMPOSTOR_DRAW_BAND} and collides with no other band${LF}`)
