import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { DEFAULT_MOVEMENT } from '../src/shared/movement.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = readFileSync(join(ROOT, 'SKILL.md'), 'utf8')
const lines = SKILL.split(/\r?\n/)
const serverStart = lines.findIndex(line => line.trim() === '## Server ctx API')
assert.ok(serverStart >= 0, 'SKILL.md no longer has a Server ctx API section')
let serverEnd = lines.length
for (let i = serverStart + 1; i < lines.length; i += 1) {
  if (/^## /.test(lines[i])) { serverEnd = i; break }
}

const codeSpans = []
let inFence = false
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  if (/^\s*```/.test(line)) { inFence = !inFence; continue }
  if (inFence) {
    if (i >= serverStart && i < serverEnd) codeSpans.push(line)
  } else {
    for (const match of line.matchAll(/`([^`]+)`/g)) codeSpans.push(match[1])
  }
}

const members = new Set()
for (const span of codeSpans) {
  for (const match of span.matchAll(/ctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) members.add(match[1])
}

await installSpecifierHooks()
const { AppContext } = await import('../src/apps/AppContext.js')
const own = new Set(Object.getOwnPropertyNames(AppContext.prototype))
const missing = [...members].filter(name => !own.has(name)).sort()
const defineMembers = [...members].filter(name => name.startsWith('define'))

assert.ok(members.size >= 10, `SKILL.md documents only ${members.size} ctx member(s)`)
assert.equal(missing.length, 0, `SKILL.md documents ctx member(s) absent from AppContext.prototype: ${missing.join(', ')}`)
assert.ok(defineMembers.length >= 5, `SKILL.md documents only ${defineMembers.length} ctx.define* member(s)`)

const documentedDefaults = [...SKILL.matchAll(/code default is\s+([0-9]+(?:\.[0-9]+)?)/gi)].map(match => Number(match[1]))
assert.ok(documentedDefaults.length >= 1, 'SKILL.md no longer names the code default maxSpeed')
for (const value of documentedDefaults) {
  assert.equal(value, DEFAULT_MOVEMENT.maxSpeed, `SKILL.md documents maxSpeed default ${value}, src/shared/movement.js says ${DEFAULT_MOVEMENT.maxSpeed}`)
}

console.log(`RESULT: PASS ${members.size} ctx member(s) (${defineMembers.length} define*) exist on AppContext.prototype, ${documentedDefaults.length} documented maxSpeed default(s) equal ${DEFAULT_MOVEMENT.maxSpeed}`)
