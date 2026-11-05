import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href)

const PIN_SHA256 = '1d9d47b1985bda74e99c0ddc7874035b038834b61db170bf8fd51b00350fadb0'
const DIRECTIONS = 4096

let failures = 0
function expect(name, ok, detail = '') {
  if (ok) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name} ${detail}`) }
}

const { loadWorldModule } = await imp('src/sdk/WorldLocator.js')
const { resolveTerrainConfig } = await imp('src/shared/terrainConfig.js')
const { loadPlanetSampler, planetSamplerOptsOf } = await imp('src/terrain/TerrainPhysics.js')
const loaded = await loadWorldModule(path.join(REPO, 'apps', 'world', 'tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))

let seed = 0x9e3779b9 >>> 0
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296
}
const dirs = []
for (let i = 0; i < DIRECTIONS; i++) {
  const x = next() * 2 - 1, y = next() * 2 - 1, z = next() * 2 - 1
  const l = Math.hypot(x, y, z) || 1
  dirs.push([x / l, y / l, z / l])
}

const values = new Float64Array(DIRECTIONS)
for (let i = 0; i < DIRECTIONS; i++) values[i] = sampler.heightAt(dirs[i])

const digest = createHash('sha256').update(Buffer.from(values.buffer)).digest('hex')
expect('every height is finite', values.every(Number.isFinite))
expect('height digest matches the pinned bits', PIN_SHA256 !== '' && digest === PIN_SHA256, `digest=${digest}`)

const TIMED = 20000
const t0 = performance.now()
let acc = 0
for (let i = 0; i < TIMED; i++) acc += sampler.heightAt(dirs[i % DIRECTIONS])
const elapsed = performance.now() - t0
console.log(`evidence heightAt ${(elapsed * 1000 / TIMED).toFixed(2)} us/call over ${TIMED} calls (acc ${Number.isFinite(acc)})`)
console.log(`evidence digest ${digest}`)

console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failures === 0 ? 0 : 1)
