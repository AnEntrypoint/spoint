import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/workspace/spoint/src'
const FACTORIES = {
  defineQuestSystem: 'defineQuestSystem', defineStatsSystem: 'defineStatsSystem', defineProgression: 'defineProgression',
  defineGameFSM: 'defineGameFSM', defineGameMode: 'defineGameMode', defineBuffStack: 'createBuffStack',
  defineShrinkingZone: 'defineShrinkingZone', defineHealth: 'defineHealth', defineCombat: 'defineCombat',
  defineFire: 'defineFire', defineSteering: 'defineSteering', defineCameraRig: 'defineCameraRig',
  defineCheckpoint: 'defineCheckpoint', definePickup: 'definePickup', defineDestructible: 'createDestructible',
  defineSoftbody: 'createSoftbodyCloth', defineFluid: 'createFluidBody', defineFluid3D: 'createFluid3DBody',
  defineBuoyancy: 'defineBuoyancy', defineTeams: 'defineTeams', defineWeapon: 'defineWeapon',
  definePlayerInventory: 'definePlayerInventory', createTween: 'createTween',
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.js')) out.push(path)
  }
}
const files = []
walk(ROOT, files)
const byFactory = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const fn of new Set(Object.values(FACTORIES))) {
    const re = new RegExp('export\\s+(?:async\\s+)?function\\s+' + fn + '\\b|export\\s+const\\s+' + fn + '\\s*=')
    if (re.test(text)) byFactory.set(fn, { file, text })
  }
}

const reSpecDot = new RegExp('(?:spec|opts|options)\\??\\.\\s*([A-Za-z_$][\\w$]*)', 'g')
const reBracket = new RegExp('(?:spec|opts|options)\\s*\\[\\s*[\'"]([^\'"]+)[\'"]\\s*\\]', 'g')
const reDestructure = new RegExp('(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:spec|opts|options)\\b', 'g')
const reParam = new RegExp('function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\{([^}]*)\\}', 'g')
const reFire = new RegExp('(?:_fire|fire|callHook|emit)\\s*\\(\\s*[\'"]([^\'"]+)[\'"]', 'g')

function keysFor(fn) {
  const entry = byFactory.get(fn)
  if (!entry) return null
  const { file, text } = entry
  const keys = new Set()
  for (const m of text.matchAll(reSpecDot)) keys.add(m[1])
  for (const m of text.matchAll(reBracket)) keys.add(m[1])
  for (const m of text.matchAll(reDestructure)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[=:]/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name)
    }
  }
  for (const m of text.matchAll(reParam)) {
    if (m[1] !== fn) continue
    for (const part of m[2].split(',')) {
      const name = part.trim().split(/[=:]/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name)
    }
  }
  for (const m of text.matchAll(reFire)) keys.add(m[1])
  keys.delete('name')
  keys.delete('length')
  keys.delete('constructor')
  return { file: file.replace('/workspace/spoint/', ''), keys: [...keys].sort() }
}

const out = {}
for (const [method, fn] of Object.entries(FACTORIES)) {
  const got = keysFor(fn)
  if (!got) { out[method] = { error: 'factory not found' }; continue }
  out[method] = got
}
console.log(JSON.stringify(out, null, 2))
