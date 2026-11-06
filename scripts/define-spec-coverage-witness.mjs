import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { DEFINE_SPEC_KEYS, assertDefineSpecKeys, assertDefineNumber } = await import('../src/behaviours/specBoundary.js')
const { AppContext } = await import('../src/apps/AppContext.js')
const { definePath } = await import('../src/behaviours/path.js')
const { defineBuoyancy } = await import('../src/behaviours/buoyancy.js')
const { defineCheckpoint } = await import('../src/behaviours/checkpoint.js')
const { defineCombat } = await import('../src/behaviours/combat.js')

const typo = '__typo_probe__'
const factories = Object.keys(DEFINE_SPEC_KEYS).filter(name => name !== 'definePathOptions')
let refused = 0
for (const name of factories) {
  assert.equal(typeof AppContext.prototype[name], 'function', `${name} must exist on AppContext.prototype`)
  assert.throws(() => AppContext.prototype[name].call({}, { [typo]: 1 }), e => e.reasonCode === 'define-spec-unknown-key' && e.field === typo, `${name} must refuse a typo key`)
  refused++
  const known = DEFINE_SPEC_KEYS[name][0]
  if (known) assert.doesNotThrow(() => assertDefineSpecKeys(name, { [known]: undefined }), `${name} must accept its own key ${known}`)
}
assert.equal(refused, 23, 'all 23 spec-taking factories must be covered')

assert.throws(() => definePath([[0, 0, 0], [1, 0, 0]], { [typo]: 1 }), e => e.reasonCode === 'define-spec-unknown-key' && e.field === typo)
assert.throws(() => definePath([[0, 0, 0], [1, 0, 0]], { closed: true, [typo]: 1 }), e => e.reasonCode === 'define-spec-unknown-key')

const stub = { seaLevel: 0, entity: { position: [0, 0, 0] }, players: { getAll: () => [] } }
for (const bad of [{ halfHeight: -1 }, { halfHeight: NaN }, { floatFactor: 'fast' }, { linearDrag: Infinity }, { buoyantForce: -2 }]) {
  assert.throws(() => defineBuoyancy(bad, stub), e => e.reasonCode === 'define-spec-invalid-field', `buoyancy must refuse ${JSON.stringify(bad)}`)
}
assert.ok(defineBuoyancy({ halfHeight: 0.5, floatFactor: 1.2 }, stub))
for (const bad of [{ minY: NaN }, { minY: 'low' }, { radius: 0 }, { radius: -3 }, { checkpoints: 'none' }]) {
  assert.throws(() => defineCheckpoint({ spawn: [0, 0, 0], ...bad }, stub), e => e.reasonCode === 'define-spec-invalid-field', `checkpoint must refuse ${JSON.stringify(bad)}`)
}
assert.ok(defineCheckpoint({ spawn: [0, 0, 0] }, stub))
for (const bad of [NaN, -1, 'soon', Infinity]) {
  assert.throws(() => defineCombat({ powerupRespawnMs: bad }, stub), e => e.reasonCode === 'define-spec-invalid-field', `combat must refuse powerupRespawnMs=${String(bad)}`)
}
assert.doesNotThrow(() => assertDefineNumber('defineCombat', 'powerupRespawnMs', 500, { min: 0 }))

function topLevelKeys(text, openIndex) {
  const keys = []
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i], next = text[i + 1]
    if (lineComment) { if (ch === '\n') lineComment = false; continue }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++ } continue }
    if (quote) { if (ch === '\\') { i++; continue } if (ch === quote) quote = null; continue }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; if (depth <= 0) break; continue }
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      const start = i
      while (i < text.length && /[\w$]/.test(text[i + 1] || '')) i++
      const word = text.slice(start, i + 1)
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === ':') keys.push(word)
    }
  }
  return keys
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.js')) out.push(path)
  }
}
const appFiles = []
for (const root of ['apps', 'src/stdlib-apps']) walk(join(process.cwd(), root), appFiles)
const shippedViolations = []
let shippedSpecs = 0
for (const file of appFiles) {
  const text = readFileSync(file, 'utf8')
  for (const name of factories) {
    const needle = 'ctx.' + name + '({'
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      from = at + needle.length
      shippedSpecs++
      for (const key of topLevelKeys(text, at + needle.length - 1)) {
        if (!DEFINE_SPEC_KEYS[name].includes(key)) shippedViolations.push({ file: file.replace(process.cwd() + '/', ''), name, key })
      }
    }
  }
}
assert.deepEqual(shippedViolations, [], `shipped app specs must not use unknown keys: ${JSON.stringify(shippedViolations.slice(0, 5))}`)

console.log(`RESULT: PASS ${refused} ctx.define* factories refuse a typo key, path/buoyancy/checkpoint/combat refuse invalid present values by code, and ${shippedSpecs} shipped spec call(s) use only known keys`)
