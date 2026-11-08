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

const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const blocks = [...README.matchAll(/^\s*movement:\s*\{([^}]*)\}/gm)]
check('README.md has exactly one movement block', blocks.length === 1, `blocks=${blocks.length}`)
const readmeMovement = {}
for (const entry of (blocks[0] ? blocks[0][1] : '').split(',')) {
  const m = entry.match(/^\s*([A-Za-z]+)\s*:\s*([0-9.]+)\s*$/)
  if (m) readmeMovement[m[1]] = Number(m[2])
}
const readmeKeys = Object.keys(readmeMovement)
check('the README block names the seven Quake-like keys', readmeKeys.length === 7, readmeKeys.join(','))

const mismatches = (defaults, expected) => {
  const out = []
  for (const key of Object.keys(expected)) {
    if (!Object.hasOwn(defaults, key)) out.push(`${key} missing`)
    else if (defaults[key] !== expected[key]) out.push(`${key} ${defaults[key]} != ${expected[key]}`)
  }
  return out
}

const real = mismatches(DEFAULT_MOVEMENT, readmeMovement)
check('the code default equals the README movement block', real.length === 0, real.join('; ') || 'none')
check('the code default names sprintSpeed', Object.hasOwn(DEFAULT_MOVEMENT, 'sprintSpeed'), `sprintSpeed=${DEFAULT_MOVEMENT.sprintSpeed}`)

const perturbedMax = mismatches({ ...readmeMovement, maxSpeed: 13 }, readmeMovement)
check('a perturbed maxSpeed (13) is reported as a mismatch', perturbedMax.length === 1 && perturbedMax[0] === 'maxSpeed 13 != 14', perturbedMax.join('; ') || 'none')

const { sprintSpeed: _dropped, ...withoutSprint } = readmeMovement
const perturbedSprint = mismatches(withoutSprint, readmeMovement)
check('a default without sprintSpeed is reported as a mismatch', perturbedSprint.length === 1 && perturbedSprint[0] === 'sprintSpeed missing', perturbedSprint.join('; ') || 'none')

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS src/shared/movement.js DEFAULT_MOVEMENT equals the README movement block, and a perturbed copy is reported')
process.exit(0)
