import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import * as TC from '../../src/shared/terrainConfig.js'

const arg = (k, d = null) => { const p = process.argv.find(a => a.startsWith(`--${k}=`)); return p ? p.slice(k.length + 3) : d }
const outPath = arg('out')
const expect = arg('expect')

const FIXTURES = [
  {},
  { seed: 7, radius: 1000 },
  { seed: 7, radius: 1000, hashVersion: 1, carves: [{ center: [0, 0], radius: 10, falloff: 5 }] },
  { seed: 7, radius: 1000, hashVersion: 2, carves: [{ center: [10, 20], radius: 10, falloff: 5 }], anchorDir: [0, 1, 0], center: [5, 5], minimapExtent: 512, minimapRes: 128, reliefScale: 0.5 },
  { seed: 3, radius: 200000 },
  { seed: 1, radius: 100, hashVersion: 3 },
  { seed: 1, radius: -5 },
  { seed: 1, radius: 100, carves: [{ center: [0, 0], radius: -1, falloff: 1 }] },
  { seed: 1, radius: 100, carves: 'nope' },
  { seed: 1, radius: 100, enabled: false },
]

const thrown = f => { try { return { value: f() } } catch (e) { return { threw: `${e.name}: ${e.message}` } } }
const picked = o => (o && typeof o === 'object' && 'ok' in o) ? { ok: o.ok, path: o.path ?? null, reason: o.reason ?? null } : o
const replacer = (k, v) => (v === undefined ? null : v)
const same = (a, b) => JSON.stringify(a, replacer) === JSON.stringify(b, replacer)

const rows = FIXTURES.map(t => {
  const parse = picked(TC.parseTerrainConfig(t))
  return {
    fixture: t,
    parse,
    hashVersion: thrown(() => TC.terrainHashVersionOf(t)),
    carves: thrown(() => TC.terrainCarvesOf(t)),
    bakeKey: parse.ok ? thrown(() => TC.terrainBakeKey(t)) : 'skipped-invalid',
    minimapBase: thrown(() => TC.minimapBaseName('world-one', t)),
    extent: thrown(() => TC.minimapExtentOf(t)),
    res: thrown(() => TC.minimapResOf(t)),
    descriptor: parse.ok ? thrown(() => TC.minimapDescriptor('world-one', t)) : 'skipped-invalid',
    bakeParams: parse.ok ? thrown(() => TC.minimapBakeParams(t)) : 'skipped-invalid',
  }
})

const world = { terrain: { seed: 1, radius: 100 } }
const extras = {
  tagged: thrown(() => TC.minimapTaggedBaseName('world-one', 9, 1)),
  override: [null, '', '1', '2', '5'].map(v => thrown(() => TC.parseTerrainHashOverride(v))),
  withSeed: TC.withTerrainSeed(world, 42),
  withHash: TC.withTerrainHashVersion(world, 1),
  resolve: TC.resolveTerrainConfig(world),
}

const payload = JSON.stringify({ rows, extras }, replacer)
const digest = createHash('sha256').update(payload).digest('hex')
if (outPath) writeFileSync(outPath, payload)

const fails = []
if (expect) {
  if (digest !== expect) fails.push(`digest drifted: ${digest} != expected ${expect}`)
  if (typeof TC.isParsedTerrainConfig !== 'function') fails.push('isParsedTerrainConfig is not exported')
  const p = TC.parseTerrainConfig({ seed: 7, radius: 1000 })
  if (!p.ok) fails.push('parse of { seed, radius } rejected')
  else {
    const c = p.config
    if (!TC.isParsedTerrainConfig(c)) fails.push('parsed record is not branded')
    if (TC.isParsedTerrainConfig({ ...c })) fails.push('a spread copy of the record still brands as parsed')
    if (!Object.isFrozen(c)) fails.push('parsed record is not frozen')
    if (c.hashVersion !== 2) fails.push(`default hashVersion not materialised: ${c.hashVersion}`)
    if (JSON.stringify(c.anchorDir) !== '[0,1,0]') fails.push(`default anchorDir not materialised: ${JSON.stringify(c.anchorDir)}`)
    if (JSON.stringify(c.center) !== '[0,0]') fails.push(`default center not materialised: ${JSON.stringify(c.center)}`)
    if (JSON.stringify(c.carveInputs) !== '[]') fails.push(`default carveInputs not materialised: ${JSON.stringify(c.carveInputs)}`)
    if (c.res !== 256) fails.push(`default res not materialised: ${c.res}`)
    if (c.enabled !== true) fails.push(`default enabled not materialised: ${c.enabled}`)
  }
  const legacy = TC.parseTerrainConfig({ seed: 7, radius: 1000, hashVersion: 1, carves: [{ center: [1, 2], radius: 3, falloff: 4 }] })
  if (!legacy.ok) fails.push('legacy parse rejected')
  else {
    if (legacy.config.hashVersion !== 1) fails.push('legacy hashVersion wrong')
    if (JSON.stringify(legacy.config.carveInputs) !== '[]') fails.push('legacy carveInputs must be []')
    if (legacy.config.carves.length !== 0) fails.push('legacy carves must be []')
  }
  for (let i = 0; i < FIXTURES.length; i++) {
    const t = FIXTURES[i]
    const pr = TC.parseTerrainConfig(t)
    if (!pr.ok) continue
    const c = pr.config
    if (!Object.is(TC.terrainBakeKey(t), TC.terrainBakeKey(c))) fails.push(`f${i}: bakeKey not a projection of the parsed record`)
    if (!same(thrown(() => TC.minimapBakeParams(t)), thrown(() => TC.minimapBakeParams(c)))) fails.push(`f${i}: bakeParams not a projection of the parsed record`)
    if (!same(thrown(() => TC.minimapDescriptor('world-one', t)), thrown(() => TC.minimapDescriptor('world-one', c)))) fails.push(`f${i}: descriptor not a projection of the parsed record`)
    if (!Object.is(TC.minimapExtentOf(t), TC.minimapExtentOf(c))) fails.push(`f${i}: extent not a projection of the parsed record (${TC.minimapExtentOf(t)} vs ${TC.minimapExtentOf(c)})`)
    if (!Object.is(TC.minimapResOf(t), TC.minimapResOf(c))) fails.push(`f${i}: res not a projection of the parsed record`)
    if (!Object.is(TC.terrainHashVersionOf(t), TC.terrainHashVersionOf(c))) fails.push(`f${i}: hashVersion not a projection of the parsed record`)
    if (!same(TC.terrainCarvesOf(t), TC.terrainCarvesOf(c))) fails.push(`f${i}: carves not a projection of the parsed record`)
  }
  const bad = [{ seed: 1, radius: 100, hashVersion: 3 }, { seed: 1, radius: -5 }, { seed: 1, radius: 100, carves: 'nope' }]
  for (const b of bad) {
    const r = thrown(() => TC.terrainBakeKey(b))
    if (!('threw' in r)) fails.push(`terrainBakeKey accepted a config parseTerrainConfig rejects: ${JSON.stringify(b)}`)
  }
}

// --- WADLER-red-w4-1: bake-minimap takes the parsed record straight through; no default survives ---
if (expect) {
  const { spawnSync } = await import('node:child_process')
  const { rmSync, readFileSync } = await import('node:fs')
  const nodePath = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const REPO = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const athrown = async f => { try { return { value: await f() } } catch (e) { return { threw: `${e.name}: ${e.message}` } } }
  const { parseMinimapBakeOpts } = await import('../../scripts/bake-minimap.mjs')

  const HOLED = ['anchorDir', 'center', 'carves', 'extent', 'res', 'hashVersion']
  for (let i = 0; i < FIXTURES.length; i++) {
    const pr = TC.parseTerrainConfig(FIXTURES[i])
    if (!pr.ok) continue
    const c = pr.config
    if (!Number.isFinite(c.seed) || !(c.radius > 0)) continue
    const r = parseMinimapBakeOpts(c)
    if (!r.ok) fails.push(`f${i}: bake opts rejected a parsed record: ${r.field}: ${r.reason}`)
    else if (!Object.is(r.config, c)) fails.push(`f${i}: bake opts rebuilt the record instead of passing it through`)
    for (const k of HOLED) {
      const holed = { ...c }
      delete holed[k]
      const rr = parseMinimapBakeOpts(holed)
      if (rr.ok) fails.push(`f${i}: bake opts materialised its own ${k} instead of rejecting the record without one`)
      else if (rr.field !== k) fails.push(`f${i}: a record missing ${k} was rejected as ${rr.field}`)
    }
  }

  const carved = TC.parseTerrainConfig({ seed: 1337, radius: 63600, reliefScale: 0.001, carves: [{ center: [10, 20], radius: 60, falloff: 40 }] })
  if (!carved.ok) fails.push('carved fixture rejected')
  else {
    const c = carved.config
    if (!c.carves.every(v => 'dir' in v && 'innerM' in v && 'outerM' in v)) fails.push('parsed carves is not the mapped { dir, innerM, outerM } shape')
    if (!c.carveInputs.every(v => 'center' in v && 'radius' in v && 'falloff' in v)) fails.push('parsed carveInputs is not the canonical { center, radius, falloff } shape')
    const shape = { seed: c.seed | 0, radius: c.radius, reliefScale: c.reliefScale, anchorDir: c.anchorDir, hashVersion: TC.minimapBakeParams(c).hashVersion, carves: TC.minimapBakeParams(c).carves, extent: TC.minimapExtentOf(c), res: TC.minimapResOf(c), center: c.center || [0, 0] }
    const r = parseMinimapBakeOpts(shape)
    if (!r.ok) fails.push(`src/sdk/MinimapBake.js bake opts shape rejected: ${r.field}: ${r.reason}`)
    const { createHeightSampler } = await import('mapspinner/height-cpu')
    const small = { radius: 1000, seed: 7, reliefScale: 0.001, hashVersion: c.hashVersion }
    const mapped = await athrown(() => createHeightSampler({ ...small, carves: c.carves }))
    const canonical = await athrown(() => createHeightSampler({ ...small, carves: c.carveInputs }))
    if ('threw' in mapped) fails.push(`height-cpu rejects the mapped carves the bake feeds it: ${mapped.threw}`)
    if (!('threw' in canonical)) fails.push('height-cpu accepted canonical carveInputs, so the row parenthetical stands')
  }

  const headRel = 'scripts/.w4-1-head.mjs'
  const headAbs = nodePath.join(REPO, headRel)
  try { rmSync(headAbs) } catch {}
  const head = spawnSync('git', ['show', 'HEAD:scripts/bake-minimap.mjs'], { cwd: REPO, encoding: 'utf8' })
  if (head.status !== 0) fails.push('could not read HEAD:scripts/bake-minimap.mjs')
  else {
    writeFileSync(headAbs, head.stdout)
    const bakeBoth = (args, tag) => {
      const out = `.gm/witness-out/.w4-1-${tag}.png`
      const json = out.replace(/\.png$/, '.json')
      const one = (script) => {
        for (const p of [out, json]) { try { rmSync(nodePath.join(REPO, p)) } catch {} }
        const r = spawnSync(process.execPath, [script, ...args, '--out', out], { cwd: REPO, encoding: 'utf8' })
        const read = (p) => { try { return readFileSync(nodePath.join(REPO, p)) } catch { return null } }
        const header = (() => { const b = read(json); return b ? JSON.parse(b) : null })()
        const png = read(out)
        for (const p of [out, json]) { try { rmSync(nodePath.join(REPO, p)) } catch {} }
        return { code: r.status, err: (r.stderr || '').trim().slice(0, 200), header, png }
      }
      return { now: one('scripts/bake-minimap.mjs'), before: one(headRel) }
    }
    const strip = h => { if (!h) return null; const c = { ...h }; delete c.generatedAt; return c }
    const world = bakeBoth(['--world', 'index', '--res', '64'], 'world')
    for (const [tag, b] of [['now', world.now], ['before', world.before]]) {
      if (b.code !== 0) fails.push(`${tag} bake of world "index" exited ${b.code}: ${b.err}`)
      if (!b.header) fails.push(`${tag} bake of world "index" produced no header`)
    }
    if (world.now.header && world.before.header) {
      const a = strip(world.now.header), z = strip(world.before.header)
      if (JSON.stringify(a) !== JSON.stringify(z)) fails.push(`world bake header drifted\n  now    ${JSON.stringify(a)}\n  before ${JSON.stringify(z)}`)
      if (!world.now.png || !world.before.png || Buffer.compare(world.now.png, world.before.png) !== 0) fails.push('world bake png bytes drifted')
      if (!a.carves.every(v => 'dir' in v && 'innerM' in v && 'outerM' in v)) fails.push('baked header carves is not the mapped shape height-cpu consumed')
    }
    const cli = bakeBoth(['--radius', '1000', '--res', '8'], 'cli')
    if (cli.now.code !== 0) fails.push(`cli bake exited ${cli.now.code}: ${cli.now.err}`)
    else if (cli.now.header) {
      const wantExtent = TC.minimapExtentOf({ radius: 1000 })
      if (cli.now.header.extent !== wantExtent) fails.push(`cli extent ${cli.now.header.extent} is not src/shared's ${wantExtent}`)
    }
    try { rmSync(headAbs) } catch {}
  }
}

console.log(`SHA256 ${digest}`)
if (fails.length) { for (const f of fails) console.log(`FAIL ${f}`); console.log('RESULT: FAIL'); process.exit(1) }
console.log('RESULT: PASS')
