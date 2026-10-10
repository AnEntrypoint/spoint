import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WITNESS = 'scripts/gold-coin-index-witness.mjs'
const DEFAULT_MODULE = 'apps/gold-coin/index.js'
const OUT_DIR = '.gm/witness-out/'
const COIN_ID = 'coin-7'
const COLLECT_CHANNEL = 'gold-coin-collected'
const CUSTOM_DEFAULTS = { itemType: 'gold-coin', collected: false, mesh: 'sphere', color: 0xffd700, r: 0.3, spin: 3 }
const RENDER_CUSTOM = { mesh: 'sphere', color: 0xffd700, r: 0.3, spin: 3, glow: true, glowColor: 0xffed4e, glowIntensity: 0.8 }

const results = []

const flag = (name) => {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith('--' + name + '='))
  return hit === undefined ? null : hit.slice(name.length + 3)
}
const toRel = (absPath) => relative(REPO, absPath).replace(/\\/g, '/')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const canon = (value) => {
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return 'function'
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}'
}

const expect = (id, actual, expected) => {
  const got = canon(actual)
  const want = canon(expected)
  results.push({ pass: got === want, line: id + ' actual=' + got + ' expected=' + want })
}

const section = (id, body) => {
  try {
    body()
  } catch (error) {
    results.push({ pass: false, line: id + '.no-exception actual=' + (error && error.message) + ' expected=none' })
  }
}

const player = (id, x, y, z) => ({ id, state: { position: [x, y, z] } })

const makeWorld = (players, coinPosition = [0, 0, 0]) => {
  const world = {
    emitted: [],
    destroyed: 0,
    playersQueries: 0,
    timers: [],
    colliders: [],
    entity: {
      id: COIN_ID,
      position: coinPosition.slice(),
      rotation: [0, 0, 0, 1],
      custom: {},
      destroy: () => {
        world.destroyed += 1
      },
    },
    physics: { addColliderFromConfig: (config) => { world.colliders.push(config) } },
    time: { every: (interval, fn) => { world.timers.push({ interval, fn }) } },
    players: {
      getAll: () => {
        world.playersQueries += 1
        return players
      },
    },
    bus: { emit: (channel, payload) => { world.emitted.push({ channel, payload }) } },
  }
  return world
}

const setupWorld = (mod, world) => {
  mod.server.setup(world)
  return world
}

const tick = (world) => {
  for (const timer of world.timers) timer.fn()
  return world
}

const collectedBy = (world) => world.emitted.map((event) => event.payload.playerId)

const checks = (ns) => {
  const mod = ns.default

  section('export', () => {
    expect('export.names', Object.keys(ns).sort(), ['default'])
    expect('export.default-is-object', typeof mod === 'object' && mod !== null, true)
  })
  section('shape', () => {
    expect('shape.server-hooks', [typeof mod.server.setup, typeof mod.server.update], ['function', 'function'])
    expect('shape.client-render', typeof mod.client.render, 'function')
  })
  section('setup', () => {
    const world = setupWorld(mod, makeWorld([]))
    expect('setup.custom-block', world.entity.custom, CUSTOM_DEFAULTS)
    expect('setup.collider-once', world.colliders, [{ type: 'sphere', radius: 0.3 }])
    expect('setup.timer-interval', world.timers.map((timer) => timer.interval), [0.1])
    expect('setup.emits-nothing', world.emitted, [])
    expect('setup.destroys-nothing', world.destroyed, 0)
  })
  section('tick-no-players', () => {
    const world = tick(setupWorld(mod, makeWorld([])))
    expect('tick.no-players-silent', [world.emitted, world.destroyed], [[], 0])
    expect('tick.reads-players-api-once', world.playersQueries, 1)
  })
  section('range', () => {
    const diagonal = tick(setupWorld(mod, makeWorld([player('p-diagonal', 1.5, 0, 1.5)])))
    expect('range.diagonal-2.12m-silent', [diagonal.emitted, diagonal.destroyed], [[], 0])
    const edge = tick(setupWorld(mod, makeWorld([player('p-edge', 2, 0, 0)])))
    expect('range.exactly-2m-silent', [edge.emitted, edge.destroyed], [[], 0])
    const inside = tick(setupWorld(mod, makeWorld([player('p-in', 1.9, 0, 0)])))
    expect('range.1.9m-collected-by', collectedBy(inside), ['p-in'])
    expect('range.1.9m-destroyed-once', inside.destroyed, 1)
    const axis = tick(setupWorld(mod, makeWorld([player('p-z', 0, 0, 1.5)])))
    expect('range.axis-1.5m-collected-by', collectedBy(axis), ['p-z'])
    const high = tick(setupWorld(mod, makeWorld([player('p-high', 0.5, 50, 0.5)])))
    expect('range.height-ignored-collected-by', collectedBy(high), ['p-high'])
    const offset = tick(setupWorld(mod, makeWorld([player('p-off', 10.5, 7, 10)], [10, 0, 10])))
    expect('range.coin-offset-collected-by', collectedBy(offset), ['p-off'])
    const offsetFar = tick(setupWorld(mod, makeWorld([player('p-origin', 0, 0, 0)], [10, 0, 10])))
    expect('range.coin-offset-origin-silent', [offsetFar.emitted, offsetFar.destroyed], [[], 0])
  })
  section('collect-payload', () => {
    const world = tick(setupWorld(mod, makeWorld([player('p1', 0.5, 0, 0)])))
    expect('collect.event-payload', world.emitted, [{ channel: COLLECT_CHANNEL, payload: { playerId: 'p1', coin: COIN_ID } }])
    expect('collect.destroys-once', world.destroyed, 1)
  })
  section('collect-mixed', () => {
    const world = tick(setupWorld(mod, makeWorld([player('p-far', 5, 0, 0), player('p-near', 1, 0, 0)])))
    expect('mixed.only-in-range-collected', collectedBy(world), ['p-near'])
    expect('mixed.destroys-once', world.destroyed, 1)
  })
  section('collect-two-in-range', () => {
    const world = tick(setupWorld(mod, makeWorld([player('p1', 0.5, 0, 0), player('p2', 0, 0, 1)])))
    expect('two-in-range.emitted-count', world.emitted.length, 1)
    expect('two-in-range.collected-by', collectedBy(world), ['p1'])
    expect('two-in-range.destroys-once', world.destroyed, 1)
    expect('two-in-range.latch-set', world.entity.custom.collected, true)
  })
  section('collect-latch-across-ticks', () => {
    const world = setupWorld(mod, makeWorld([player('p1', 0.5, 0, 0), player('p2', 0, 0, 1)]))
    tick(world)
    tick(world)
    tick(world)
    expect('latch.emitted-count-after-three-ticks', world.emitted.length, 1)
    expect('latch.destroys-once-after-three-ticks', world.destroyed, 1)
  })
  section('update', () => {
    const world = makeWorld([player('p1', 0.5, 0, 0)])
    mod.server.update(world, 0.016)
    expect('update.noop', [world.emitted, world.destroyed, world.playersQueries], [[], 0, 0])
  })
  section('render', () => {
    const ctx = { entity: { id: COIN_ID, position: [1, 2, 3], rotation: [0, 0, 0, 1], custom: {} } }
    const out = mod.client.render(ctx)
    expect('render.output-keys', Object.keys(out).sort(), ['custom', 'position', 'rotation'])
    expect('render.position-passthrough', out.position, [1, 2, 3])
    expect('render.rotation-passthrough', out.rotation, [0, 0, 0, 1])
    expect('render.custom-block', out.custom, RENDER_CUSTOM)
    expect('render.leaves-entity-custom', ctx.entity.custom, {})
  })
}

const run = async (out, state) => {
  const requested = flag('module')
  const modulePath = resolve(REPO, requested === null ? DEFAULT_MODULE : requested)
  state.module = toRel(modulePath)
  out.push('ts: ' + new Date().toISOString())
  out.push('witness: ' + WITNESS)
  out.push('module: ' + state.module)
  if (!existsSync(modulePath)) {
    out.push('load: module path does not exist')
    return false
  }
  state.sha = sha256(readFileSync(modulePath))
  out.push('module_sha256: ' + state.sha)
  let ns
  try {
    ns = await import(pathToFileURL(modulePath).href)
  } catch (error) {
    out.push('load: import failed: ' + (error && error.message))
    return false
  }
  let randomCalls = 0
  const realRandom = Math.random
  Math.random = () => {
    randomCalls += 1
    return realRandom()
  }
  try {
    checks(ns)
  } finally {
    Math.random = realRandom
  }
  expect('determinism.math-random-calls', randomCalls, 0)
  const failed = results.filter((result) => !result.pass).length
  for (const result of results) out.push('CHECK ' + (result.pass ? 'PASS' : 'FAIL') + ' ' + result.line)
  out.push('checks: ' + (results.length - failed) + ' passed, ' + failed + ' failed, ' + results.length + ' total')
  state.checks = results.length
  state.failed = failed
  return failed === 0 && results.length > 0
}

const logLine = (verdict, state, outPath, outSha) =>
  new Date().toISOString() + ' | ' + WITNESS + ' | exit=' + (verdict ? 0 : 1) + ' | RESULT: ' + (verdict ? 'PASS' : 'FAIL') +
  ' | checks=' + state.checks + ' failed=' + state.failed + ' | module=' + (state.module || '-') +
  ' | module_sha256=' + (state.sha || 'none') + ' | out=' + (outPath || '-') + ' | output_sha256=' + outSha + '\n'

const main = async () => {
  const out = []
  const state = { module: null, sha: null, checks: 0, failed: 0 }
  const outPath = flag('out')
  const logPath = flag('log')
  const outFile = outPath === null ? null : resolve(REPO, outPath)
  let verdict = false
  let refused = false
  if (outFile !== null && !toRel(outFile).startsWith(OUT_DIR)) {
    refused = true
    out.push('out: refusing to write outside ' + OUT_DIR + ': ' + outPath)
  } else if (outFile !== null && existsSync(outFile)) {
    refused = true
    out.push('out: refusing to overwrite existing ' + outPath)
  } else {
    try {
      verdict = await run(out, state)
    } catch (error) {
      out.push('error: ' + (error && error.message))
    }
  }
  const render = () => out.concat(['RESULT: ' + (verdict ? 'PASS' : 'FAIL')]).join('\n') + '\n'
  let outSha = 'none'
  if (outFile !== null && !refused) {
    try {
      const text = render()
      writeFileSync(outFile, text, { flag: 'wx' })
      outSha = sha256(text)
    } catch (error) {
      verdict = false
      out.push('error: out write failed: ' + (error && error.message))
    }
  }
  if (logPath !== null) {
    try {
      appendFileSync(resolve(REPO, logPath), logLine(verdict, state, outPath, outSha))
    } catch (error) {
      verdict = false
      out.push('error: log append failed: ' + (error && error.message))
    }
  }
  process.stdout.write(render())
  process.exitCode = verdict ? 0 : 1
}

main()
