import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const { DEFAULT_MOVEMENT } = await import(pathToFileURL(path.join(ROOT, 'src/shared/movement.js')).href)
const { expandWorldPresets } = await import(pathToFileURL(path.join(ROOT, 'src/shared/worldPresets.js')).href)

const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const blocks = [...README.matchAll(/^\s*movement:\s*\{([^}]*)\}/gm)]
const readmeMovement = {}
for (const entry of (blocks[0] ? blocks[0][1] : '').split(',')) {
  const m = entry.match(/^\s*([A-Za-z]+)\s*:\s*([0-9.]+)\s*$/)
  if (m) readmeMovement[m[1]] = Number(m[2])
}
check('README.md names the seven movement keys', Object.keys(readmeMovement).length === 7, Object.keys(readmeMovement).join(','))

const resolveWorld = async (file) => {
  const def = (await import(pathToFileURL(path.join(ROOT, 'apps/world', file)).href)).default
  return { ...DEFAULT_MOVEMENT, ...(expandWorldPresets(def).movement || {}) }
}

const mismatches = (resolved, expected) => {
  const out = []
  for (const key of Object.keys(expected)) {
    if (!Object.hasOwn(resolved, key)) out.push(`${key} missing`)
    else if (resolved[key] !== expected[key]) out.push(`${key} ${resolved[key]} != ${expected[key]}`)
  }
  return out
}

const defaultWorld = await resolveWorld('tps-game.js')
const defaultMismatch = mismatches(defaultWorld, readmeMovement)
check('the default world tps-game resolves to the README movement block', defaultMismatch.length === 0, defaultMismatch.join('; ') || 'none')

const indexWorld = await resolveWorld('index.js')
const indexMismatch = mismatches(indexWorld, readmeMovement)
check('apps/world/index.js (the default-world export) resolves to the README block', indexMismatch.length === 0, indexMismatch.join('; ') || 'none')

for (const file of ['construct.js', 'tutorial.js', 'arena-combat.js', 'deathrun.js']) {
  const resolved = await resolveWorld(file)
  const diff = mismatches(resolved, { maxSpeed: readmeMovement.maxSpeed, sprintSpeed: readmeMovement.sprintSpeed })
  check(`${file} (tps preset) resolves maxSpeed and sprintSpeed to the README values`, diff.length === 0, diff.join('; ') || 'none')
}

const perturbed = mismatches({ ...defaultWorld, maxSpeed: 7 }, readmeMovement)
check('a default world with maxSpeed 7 is reported as a mismatch', perturbed.length === 1 && perturbed[0] === 'maxSpeed 7 != 14', perturbed.join('; ') || 'none')

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS the default world tps-game resolves maxSpeed 14, sprintSpeed 24 and the rest of the README movement block, and a perturbed value is reported')
process.exit(0)
