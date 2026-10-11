import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { flatPlanetRadius, clusterPlanetRadius } from '../src/stage/planetRadius.js'

const WITNESS_REL = 'scripts/Stage-witness.mjs'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODULE_REL = 'src/stage/Stage.js'
const DEFAULT_RELEVANCE_RADIUS_M = 200
const FLAG_NAMES = ['module', 'out', 'log', 'run']

const outcomes = []

function record(id, description, verdict) {
  if (verdict === true) {
    outcomes.push({ id, description, ok: true, detail: '' })
    return
  }
  const detail = typeof verdict === 'string' ? verdict : 'expectation not met'
  outcomes.push({ id, description, ok: false, detail })
}

function errorText(err) {
  const name = err && err.name ? err.name : 'Error'
  const message = err && err.message ? err.message : String(err)
  return name + ': ' + message
}

function attempt(id, description, check) {
  try {
    record(id, description, check())
  } catch (err) {
    record(id, description, 'threw ' + errorText(err))
  }
}

function all(...verdicts) {
  for (const verdict of verdicts) {
    if (verdict !== true) return verdict
  }
  return true
}

function same(actual, expected) {
  const got = JSON.stringify(actual)
  const want = JSON.stringify(expected)
  return got === want ? true : 'expected ' + want + ' got ' + got
}

function sortedIds(list) {
  return Array.from(list, (id) => String(id)).sort()
}

function sameIds(actual, expected) {
  return same(sortedIds(actual), sortedIds(expected))
}

function isPlusZero(value) {
  return Object.is(value, 0) ? true : 'expected +0 got ' + String(value)
}

function throwsTypeError(run, prefix) {
  let threw = false
  let thrown = null
  try {
    run()
  } catch (err) {
    threw = true
    thrown = err
  }
  if (!threw) return 'expected a TypeError, nothing was thrown'
  if (!(thrown instanceof TypeError)) return 'expected TypeError got ' + errorText(thrown)
  const message = String(thrown.message)
  if (!message.startsWith(prefix)) return 'message does not start with ' + JSON.stringify(prefix) + ': ' + message.slice(0, 160)
  return true
}

function makeRuntime(unmanagedIds) {
  const entities = new Map()
  const destroyed = []
  const spawned = []
  const runtime = {
    _activeDynamicIds: new Set(),
    entities,
    destroyed,
    spawned,
    spawnEntity(id, config) {
      spawned.push({ id, config })
      const entity = { id, position: config.position, bodyType: config.bodyType }
      entities.set(id, entity)
      return entity
    },
    destroyEntity(id) {
      destroyed.push(id)
      entities.delete(id)
    },
    getEntity(id) {
      return entities.get(id) || null
    },
  }
  if (unmanagedIds) runtime.getUnmanagedDynamicIds = () => unmanagedIds()
  return runtime
}

function boundStage(Stage, name, config, runtime) {
  const stage = new Stage(name, config)
  stage.bind(runtime)
  return stage
}

function addAt(stage, id, position, extra) {
  return stage.addEntity(id, Object.assign({ position, bodyType: 'dynamic' }, extra || {}))
}

const WORLD = [
  ['o', [0, 0, 0]],
  ['b', [3, 0, 4]],
  ['c', [0, 10, 0]],
  ['h', [5, 1000, 0]],
  ['f', [60, 0, 0]],
]

function worldStage(Stage, config) {
  const stage = boundStage(Stage, 'world', config, makeRuntime())
  for (const [id, position] of WORLD) addAt(stage, id, position.slice())
  return stage
}

function runClaims(Stage) {
  attempt('P01', 'planetRadius undefined resolves to +0 (flat stage)', () => isPlusZero(new Stage('s').spatial.planetRadius))
  attempt('P02', 'planetRadius null resolves to +0', () => isPlusZero(new Stage('s', { planetRadius: null }).spatial.planetRadius))
  attempt('P03', 'planetRadius flatPlanetRadius() resolves to +0', () => isPlusZero(new Stage('s', { planetRadius: flatPlanetRadius() }).spatial.planetRadius))
  attempt('P04', 'planetRadius clusterPlanetRadius(6371000) reaches the stage as 6371000', () => same(new Stage('s', { planetRadius: clusterPlanetRadius(6371000) }).spatial.planetRadius, 6371000))
  attempt('P05', 'planetRadius clusterPlanetRadius(0.5) reaches the stage as 0.5', () => same(new Stage('s', { planetRadius: clusterPlanetRadius(0.5) }).spatial.planetRadius, 0.5))
  attempt('P06', 'clusterPlanetRadius(0) throws the written TypeError', () => throwsTypeError(() => clusterPlanetRadius(0), '[stage] a cluster-resolved planet radius is a positive finite number of meters'))
  const invalidRadii = [
    ['0', 0],
    ['-0', -0],
    ['6371000', 6371000],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['-6371000', -6371000],
    ['"6371000"', '6371000'],
    ['false', false],
    ['true', true],
    ['[]', []],
    ['a hand-built {resolvedBy,meters} literal', { resolvedBy: 'cluster', meters: 6371000 }],
  ]
  invalidRadii.forEach(([label, value], index) => {
    const id = 'P' + String(7 + index).padStart(2, '0')
    attempt(id, 'planetRadius ' + label + ' throws the written TypeError', () =>
      throwsTypeError(() => new Stage('s', { planetRadius: value }), '[stage] stage "s" got planetRadius ' + JSON.stringify(value) + ':'))
  })

  attempt('R01', 'no relevanceRadius config gives the written default 200', () => same(new Stage('s').spatial.relevanceRadius, DEFAULT_RELEVANCE_RADIUS_M))
  attempt('R02', 'positive numeric relevanceRadius 50 passes through', () => same(new Stage('s', { relevanceRadius: 50 }).spatial.relevanceRadius, 50))
  const invalidRelevance = [['0', 0], ['-5', -5], ['NaN', NaN], ['"50"', '50'], ['null', null]]
  invalidRelevance.forEach(([label, value], index) => {
    const id = 'R' + String(3 + index).padStart(2, '0')
    attempt(id, 'relevanceRadius ' + label + ' falls back to the default 200', () =>
      same(new Stage('s', { relevanceRadius: value }).spatial.relevanceRadius, DEFAULT_RELEVANCE_RADIUS_M))
  })

  attempt('E01', 'addEntity on an unbound stage returns null and tracks nothing', () => {
    const stage = new Stage('u')
    const returned = stage.addEntity('a', { position: [0, 0, 0], bodyType: 'dynamic' })
    return all(same(returned, null), same(stage.entityCount, 0), same(stage.spatial.size, 0))
  })

  attempt('E02', 'addEntity hands its config to runtime.spawnEntity and returns the spawned entity', () => {
    const runtime = makeRuntime()
    const stage = boundStage(Stage, 'e2', {}, runtime)
    const config = { position: [1, 2, 3], bodyType: 'dynamic' }
    const returned = stage.addEntity('a', config)
    return all(
      returned === runtime.entities.get('a') ? true : 'returned value is not the spawned entity',
      same(runtime.spawned.length, 1),
      same(runtime.spawned[0].id, 'a'),
      runtime.spawned[0].config === config ? true : 'spawnEntity did not receive the config object',
    )
  })

  attempt('E03', 'addEntity tracks the id and indexes the spawned position', () => {
    const stage = boundStage(Stage, 'e3', {}, makeRuntime())
    addAt(stage, 'a', [1, 2, 3])
    return all(
      same(stage.hasEntity('a'), true),
      same(stage.entityCount, 1),
      same(stage.spatial.getPosition('a'), [1, 2, 3]),
      same(stage.getAllEntityIds(), ['a']),
    )
  })

  attempt('E04', 'an entity with no position is indexed at the origin', () => {
    const stage = boundStage(Stage, 'e4', {}, makeRuntime())
    stage.addEntity('e', { bodyType: 'dynamic' })
    return same(stage.spatial.getPosition('e'), [0, 0, 0])
  })

  attempt('E05', 'a static body is recorded in the static set', () => {
    const stage = boundStage(Stage, 'e5', {}, makeRuntime())
    addAt(stage, 'st', [0, 0, 0], { bodyType: 'static' })
    return same(stage._staticIds.has('st'), true)
  })

  attempt('E06', 'a dynamic body without autoTrimesh is not in the static set', () => {
    const stage = boundStage(Stage, 'e6', {}, makeRuntime())
    addAt(stage, 'dy', [0, 0, 0])
    return same(stage._staticIds.has('dy'), false)
  })

  attempt('E07', 'autoTrimesh puts a dynamic body in the static set', () => {
    const stage = boundStage(Stage, 'e7', {}, makeRuntime())
    addAt(stage, 'tm', [0, 0, 0], { autoTrimesh: true })
    return same(stage._staticIds.has('tm'), true)
  })

  attempt('D01', 'removeEntity on an unbound stage does nothing', () => {
    const stage = new Stage('d1')
    return all(same(stage.removeEntity('x'), undefined), same(stage.entityCount, 0))
  })

  attempt('D02', 'removeEntity drops the id from every structure and destroys it once', () => {
    const runtime = makeRuntime()
    const stage = boundStage(Stage, 'd2', {}, runtime)
    addAt(stage, 'k', [0, 0, 0], { bodyType: 'static' })
    addAt(stage, 'j', [9, 0, 9])
    stage.removeEntity('k')
    return all(
      same(stage.hasEntity('k'), false),
      same(stage.spatial.has('k'), false),
      same(stage._staticIds.has('k'), false),
      same(runtime.destroyed, ['k']),
      same(stage.entityCount, 1),
      same(stage.hasEntity('j'), true),
    )
  })

  attempt('U01', 'updateEntityPosition moves a tracked entity in the spatial index', () => {
    const stage = boundStage(Stage, 'u1', {}, makeRuntime())
    addAt(stage, 'a', [0, 0, 0])
    stage.updateEntityPosition('a', [40, 0, 0])
    return all(
      same(stage.spatial.getPosition('a'), [40, 0, 0]),
      sameIds(stage.getNearbyEntities([40, 0, 0], 1), ['a']),
      sameIds(stage.getNearbyEntities([0, 0, 0], 1), []),
    )
  })

  attempt('U02', 'updateEntityPosition ignores an id the stage does not track', () => {
    const stage = boundStage(Stage, 'u2', {}, makeRuntime())
    addAt(stage, 'a', [0, 0, 0])
    stage.updateEntityPosition('ghost', [5, 0, 5])
    return all(same(stage.spatial.has('ghost'), false), same(stage.hasEntity('ghost'), false), same(stage.entityCount, 1))
  })

  const wide = worldStage(Stage, {})
  attempt('Q01', 'getNearbyEntities radius 5 is a 3D inclusive ball', () => sameIds(wide.getNearbyEntities([0, 0, 0], 5), ['o', 'b']))
  attempt('Q02', 'getRelevantEntities radius 5 is the same 3D ball', () => sameIds(wide.getRelevantEntities([0, 0, 0], 5), ['o', 'b']))
  attempt('Q03', 'getRelevantEntitiesHorizontal radius 5 ignores height', () => sameIds(wide.getRelevantEntitiesHorizontal([0, 0, 0], 5), ['o', 'b', 'c', 'h']))
  attempt('Q04', 'omitted radius uses the default relevance radius 200 in 3D', () => sameIds(wide.getRelevantEntities([0, 0, 0]), ['o', 'b', 'c', 'f']))
  attempt('Q05', 'explicit radius 2000 reaches the far entity', () => sameIds(wide.getNearbyEntities([0, 0, 0], 2000), ['o', 'b', 'c', 'h', 'f']))
  attempt('Q06', 'getAllEntityIds lists exactly the tracked ids', () => sameIds(wide.getAllEntityIds(), ['o', 'b', 'c', 'h', 'f']))
  attempt('Q07', 'hasEntity is false for an untracked id', () => same(wide.hasEntity('nope'), false))
  const near = worldStage(Stage, { relevanceRadius: 10 })
  attempt('Q08', 'omitted radius uses a configured relevanceRadius 10 in 3D', () => sameIds(near.getNearbyEntities([0, 0, 0]), ['o', 'b', 'c']))
  attempt('Q09', 'getRelevantEntities omitted radius uses configured 10', () => sameIds(near.getRelevantEntities([0, 0, 0]), ['o', 'b', 'c']))
  attempt('Q10', 'horizontal query omitted radius uses configured 10', () => sameIds(near.getRelevantEntitiesHorizontal([0, 0, 0]), ['o', 'b', 'c', 'h']))

  attempt('S01', 'syncPositions copies runtime positions of tracked active dynamic bodies', () => {
    const runtime = makeRuntime()
    const stage = boundStage(Stage, 's1', {}, runtime)
    addAt(stage, 'd', [0, 0, 0])
    runtime.entities.get('d').position = [70, 0, 70]
    runtime._activeDynamicIds.add('d')
    stage.syncPositions()
    return same(stage.spatial.getPosition('d'), [70, 0, 70])
  })

  attempt('S02', 'syncPositions copies positions of unmanaged dynamic bodies', () => {
    const runtime = makeRuntime(() => ['u'])
    const stage = boundStage(Stage, 's2', {}, runtime)
    addAt(stage, 'u', [0, 0, 0])
    runtime.entities.get('u').position = [-50, 0, 20]
    stage.syncPositions()
    return same(stage.spatial.getPosition('u'), [-50, 0, 20])
  })

  attempt('S03', 'syncPositions skips active bodies the stage does not track', () => {
    const runtime = makeRuntime()
    const stage = boundStage(Stage, 's3', {}, runtime)
    addAt(stage, 'd', [0, 0, 0])
    runtime._activeDynamicIds.add('x')
    runtime.entities.set('x', { id: 'x', position: [100, 0, 100], bodyType: 'dynamic' })
    stage.syncPositions()
    return all(same(stage.spatial.has('x'), false), same(stage.hasEntity('x'), false))
  })

  attempt('S04', 'syncPositions on an unbound stage does nothing', () => {
    const stage = new Stage('s4')
    stage.syncPositions()
    return same(stage.entityCount, 0)
  })

  attempt('C01', 'clear destroys every tracked entity once and empties every structure', () => {
    const runtime = makeRuntime()
    const stage = boundStage(Stage, 'c1', {}, runtime)
    addAt(stage, 's1', [0, 0, 0], { bodyType: 'static' })
    addAt(stage, 's2', [10, 0, 10], { bodyType: 'static' })
    addAt(stage, 'd1', [20, 0, 20])
    stage.clear()
    return all(
      sameIds(runtime.destroyed, ['s1', 's2', 'd1']),
      same(stage.entityCount, 0),
      same(stage.spatial.size, 0),
      same(stage._staticIds.size, 0),
      same(stage.getAllEntityIds(), []),
      sameIds(stage.getNearbyEntities([0, 0, 0], 1000), []),
    )
  })

  attempt('C02', 'clear on an unbound stage does nothing', () => {
    const stage = new Stage('c2')
    stage.clear()
    return same(stage.entityCount, 0)
  })

  attempt('K01', 'defaults: name stored, gravity, spawnPoint and playerModel are null', () => {
    const stage = new Stage('nm')
    return all(same(stage.name, 'nm'), same(stage.gravity, null), same(stage.spawnPoint, null), same(stage.playerModel, null), same(stage.entityCount, 0))
  })

  attempt('K02', 'gravity, spawnPoint and playerModel keep the supplied references', () => {
    const gravity = { x: 0, y: -9.8, z: 0 }
    const spawnPoint = [0, 5, 0]
    const playerModel = { id: 'p' }
    const stage = new Stage('k2', { gravity, spawnPoint, playerModel })
    return all(
      stage.gravity === gravity ? true : 'gravity reference was not kept',
      stage.spawnPoint === spawnPoint ? true : 'spawnPoint reference was not kept',
      stage.playerModel === playerModel ? true : 'playerModel reference was not kept',
    )
  })
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function relForReport(absPath) {
  const rel = path.relative(REPO_ROOT, absPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return absPath
  return rel.split(path.sep).join('/')
}

function appendLogLine(logAbs, line) {
  const existing = isFile(logAbs) ? fs.readFileSync(logAbs, 'utf8') : ''
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lead = existing.length > 0 && !existing.endsWith('\n') ? eol : ''
  fs.appendFileSync(logAbs, lead + line + eol, 'utf8')
}

function parseFlags(argv) {
  const values = {}
  const unknown = []
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg)
    if (match && FLAG_NAMES.includes(match[1]) && !(match[1] in values)) {
      values[match[1]] = match[2]
    } else {
      unknown.push(arg)
    }
  }
  return { values, unknown }
}

function buildReport(context) {
  const failed = outcomes.filter((outcome) => !outcome.ok)
  const total = outcomes.length
  const ok = failed.length === 0
  const resultLine = ok
    ? 'RESULT: PASS (' + total + ' of ' + total + ' checks)'
    : 'RESULT: FAIL (' + failed.length + ' of ' + total + ' checks failed: ' + failed.map((outcome) => outcome.id).join(', ') + ')'
  const lines = [
    'witness: ' + WITNESS_REL,
    'run: ' + context.run,
    'ts: ' + context.ts,
    'module: ' + context.moduleShown,
    'module_sha256: ' + context.moduleSha,
    'checks: ' + total,
  ]
  for (const outcome of outcomes) {
    const tag = outcome.ok ? 'PASS' : 'FAIL'
    lines.push(outcome.id + ' ' + tag + ' ' + outcome.description + (outcome.ok ? '' : ' :: ' + outcome.detail))
  }
  lines.push(resultLine)
  const text = lines.join('\n') + '\n'
  return { text, ok, resultLine, sha256: sha256Hex(Buffer.from(text, 'utf8')) }
}

async function main() {
  const { values, unknown } = parseFlags(process.argv.slice(2))
  record('A01', 'arguments are limited to --module, --out, --log and --run with values', unknown.length === 0 ? true : 'unknown arguments: ' + unknown.join(' '))

  const moduleGiven = values.module !== undefined
  const moduleShown = moduleGiven ? values.module : DEFAULT_MODULE_REL
  const modulePath = path.resolve(moduleGiven ? values.module : path.join(REPO_ROOT, DEFAULT_MODULE_REL))
  const runLabel = values.run !== undefined ? values.run : 'unlabelled'

  let moduleSha = 'none'
  let Stage = null
  if (!isFile(modulePath)) {
    record('M01', 'module path names an existing file', 'no file at ' + modulePath)
  } else {
    moduleSha = sha256Hex(fs.readFileSync(modulePath))
    record('M01', 'module path names an existing file', true)
    try {
      const loaded = await import(pathToFileURL(modulePath).href)
      if (typeof loaded.Stage === 'function') {
        Stage = loaded.Stage
        record('M02', 'module imports cleanly and exports a Stage class', true)
      } else {
        record('M02', 'module imports cleanly and exports a Stage class', 'no Stage class export')
      }
    } catch (err) {
      record('M02', 'module imports cleanly and exports a Stage class', 'threw ' + errorText(err))
    }
  }

  if (Stage) runClaims(Stage)

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const report = buildReport({ run: runLabel, ts, moduleShown, moduleSha })
  process.stdout.write(report.text)

  let outRel = 'none'
  if (values.out !== undefined) {
    const outAbs = path.resolve(values.out)
    fs.mkdirSync(path.dirname(outAbs), { recursive: true })
    fs.writeFileSync(outAbs, report.text, 'utf8')
    outRel = relForReport(outAbs)
  }
  if (values.log !== undefined) {
    const line = [
      ts,
      'witness=' + WITNESS_REL,
      'run=' + runLabel,
      'target=' + moduleShown,
      'module_sha256=' + moduleSha,
      'exit=' + (report.ok ? 0 : 1),
      report.resultLine,
      'out=' + outRel,
      'sha256=' + report.sha256,
    ].join(' | ')
    appendLogLine(path.resolve(values.log), line)
  }
  process.exitCode = report.ok ? 0 : 1
}

main().catch((err) => {
  process.stdout.write('fatal: ' + errorText(err) + '\nRESULT: FAIL (fatal: witness could not complete)\n')
  process.exitCode = 1
})
