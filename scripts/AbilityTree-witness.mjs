import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WITNESS = 'AbilityTree-witness'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODULE = resolve(REPO_ROOT, 'src', 'game', 'AbilityTree.js')
const NONDETERMINISM = /Math\.random|\bDate\b|performance\.now|crypto\.getRandomValues|crypto\.randomUUID/g

function parseArgs(argv) {
  const options = { module: DEFAULT_MODULE, out: null, log: null, unknown: [] }
  for (const arg of argv) {
    const match = /^--(module|out|log)=(.+)$/.exec(arg)
    if (match) options[match[1]] = match[2]
    else options.unknown.push(arg)
  }
  return options
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function same(a, b) {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  if (keysA.length !== keysB.length) return false
  return keysA.every((key, i) => key === keysB[i] && same(a[key], b[key]))
}

function show(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return JSON.stringify(value)
}

function createLedger() {
  const lines = []
  const failed = []
  let total = 0
  const record = (name, compute, want) => {
    total += 1
    let got
    try {
      got = compute()
    } catch (error) {
      got = `threw: ${error && error.message}`
    }
    const label = String(total).padStart(2, '0')
    if (same(got, want)) {
      lines.push(`check ${label} PASS ${name}`)
    } else {
      failed.push(name)
      lines.push(`check ${label} FAIL ${name} got=${show(got)} want=${show(want)}`)
    }
  }
  return { record, lines, failed, total: () => total }
}

function runSuite(mod, check, source) {
  const { DEFAULT_ABILITIES, HOTKEY_MAP, createAbilityTree } = mod

  check('exports present', () => [Array.isArray(DEFAULT_ABILITIES), typeof HOTKEY_MAP, typeof createAbilityTree], [true, 'object', 'function'])
  check('default ability ids', () => DEFAULT_ABILITIES.map(a => a.id), [1, 2, 3, 4, 5])
  check('default ability names', () => DEFAULT_ABILITIES.map(a => a.name), ['Fireball', 'Frost Nova', 'Lightning Strike', 'Teleport', 'Meteor Shower'])
  check('default ability mana, cooldown, unlock level, damage', () => DEFAULT_ABILITIES.map(a => [a.manaCost, a.cooldown, a.unlockLevel, a.damage]), [[20, 2, 1, 25], [30, 5, 5, 15], [40, 4, 10, 40], [35, 8, 15, 0], [50, 10, 25, 60]])
  check('default hotkey map', () => HOTKEY_MAP, { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: null, 7: null, 8: null, 9: null })

  const tree = createAbilityTree()
  check('default tree lists the five abilities', () => tree.getAllAbilities().map(a => a.id), [1, 2, 3, 4, 5])
  check('invalid ids skipped, cooldown floor and defaults applied', () => createAbilityTree([
    { id: 7, cooldown: 0.05 },
    { id: 0, name: 'zero id' },
    { id: '8', name: 'string id' },
    { id: 9 },
    { id: 10, name: 'x', cooldown: 3, unlockLevel: 2, damage: 5, manaCost: 7 }
  ]).getAllAbilities().map(a => [a.id, a.cooldown, a.unlockLevel, a.damage, a.manaCost, a.name]), [[7, 0.1, 1, 0, 0, ''], [9, 1, 1, 0, 0, ''], [10, 3, 2, 5, 7, 'x']])
  check('empty definition list yields no abilities', () => {
    const empty = createAbilityTree([])
    return [empty.getAllAbilities(), empty.getUnlockedAbilities(99)]
  }, [[], []])
  check('unlocked ability ids by player level', () => [0, 1, 4, 5, 25].map(level => tree.getUnlockedAbilities(level).map(a => a.id)), [[], [1], [1], [1, 2], [1, 2, 3, 4, 5]])
  check('lookup returns definition or null', () => [tree.getAbility(1).name, tree.getAbility(99)], ['Fireball', null])

  check('cast of unknown ability refused', () => tree.castAbility('p1', 99, 25), false)
  check('cast of locked ability refused', () => tree.castAbility('p1', 2, 4), false)
  check('refused cast leaves no cooldown', () => tree.getAbilityCooldown('p1', 2), 0)
  check('cast of unlocked ability accepted', () => tree.castAbility('p1', 2, 5), true)
  check('cast sets cooldown to the ability cooldown', () => tree.getAbilityCooldown('p1', 2), 5)
  check('recast while cooling refused', () => tree.castAbility('p1', 2, 25), false)
  check('canCastAbility false while cooling', () => tree.canCastAbility('p1', 2), false)
  check('canCastAbility false for unknown ability', () => tree.canCastAbility('p1', 99), false)
  check('canCastAbility true when ready', () => tree.canCastAbility('p1', 1), true)
  check('active abilities list the cooling ability', () => tree.getPlayerAbilityInfo('p1', 25).activeAbilities, [2])
  check('tick reduces cooldown by dt', () => {
    tree.tick(1.5)
    return tree.getAbilityCooldown('p1', 2)
  }, 3.5)
  check('tick to zero frees the ability and clears its active flag', () => {
    tree.tick(3.5)
    return [tree.getAbilityCooldown('p1', 2), tree.canCastAbility('p1', 2), tree.getPlayerAbilityInfo('p1', 25).activeAbilities]
  }, [0, true, []])
  check('recast after expiry accepted', () => tree.castAbility('p1', 2, 5), true)
  check('cooldowns are per player', () => [tree.castAbility('p2', 1, 1), tree.getAbilityCooldown('p1', 1), tree.getAbilityCooldown('p2', 1)], [true, 0, 2])
  check('second cooldown for p2 accepted at level 10', () => tree.castAbility('p2', 3, 10), true)
  check('tick expires only the elapsed cooldowns', () => {
    tree.tick(2.5)
    return [tree.getAbilityCooldown('p1', 2), tree.getAbilityCooldown('p2', 1), tree.getAbilityCooldown('p2', 3), tree.getPlayerAbilityInfo('p2', 10).activeAbilities]
  }, [2.5, 0, 1.5, [3]])

  const hotkeys = createAbilityTree()
  check('hotkey bindings read back, empty slots read null', () => [hotkeys.getHotkeyBinding(1), hotkeys.getHotkeyBinding(6), hotkeys.getHotkeyBinding(0), hotkeys.getHotkeyBinding(10)], [1, null, null, null])
  check('empty slot accepts a known ability', () => [hotkeys.bindHotkey(6, 4), hotkeys.getHotkeyBinding(6)], [true, 4])
  check('out-of-range slot refused', () => [hotkeys.bindHotkey(0, 1), hotkeys.bindHotkey(10, 1)], [false, false])
  check('unknown ability refused and binding unchanged', () => [hotkeys.bindHotkey(7, 99), hotkeys.getHotkeyBinding(7)], [false, null])
  check('null unbinds a slot', () => [hotkeys.bindHotkey(6, null), hotkeys.getHotkeyBinding(6)], [true, null])
  check('binding view is a copy', () => {
    const view = hotkeys.getAllHotkeyBindings()
    view[1] = 77
    return [hotkeys.getHotkeyBinding(1), Object.keys(view).length]
  }, [1, 9])
  check('default hotkey map untouched by tree bindings', () => HOTKEY_MAP[6], null)

  const source_tree = createAbilityTree()
  source_tree.castAbility('pA', 1, 1)
  source_tree.tick(0.5)
  source_tree.bindHotkey(9, 3)
  const snapshot = source_tree.buildSnapshot()
  const wire = JSON.parse(JSON.stringify(snapshot))
  check('snapshot lists player cooldowns', () => snapshot.playerStates.map(s => [s.playerId, s.cooldowns]), [['pA', [[1, 1.5]]]])
  check('snapshot carries hotkey bindings', () => snapshot.hotkeys[9], 3)
  const restored = createAbilityTree()
  check('applySnapshot restores cooldowns and hotkeys', () => {
    restored.applySnapshot(wire)
    return [restored.getAbilityCooldown('pA', 1), restored.getHotkeyBinding(9), restored.getHotkeyBinding(1)]
  }, [1.5, 3, 1])
  const overwritten = createAbilityTree()
  check('applySnapshot replaces existing cooldowns', () => {
    overwritten.castAbility('pA', 2, 5)
    overwritten.applySnapshot(wire)
    return [overwritten.getAbilityCooldown('pA', 2), overwritten.getAbilityCooldown('pA', 1)]
  }, [0, 1.5])
  check('applySnapshot(null) is a no-op', () => {
    overwritten.applySnapshot(null)
    return overwritten.getAbilityCooldown('pA', 1)
  }, 1.5)

  const network = createAbilityTree()
  check('no network cooldowns without player state', () => network.getCooldownsForNetwork('nobody'), [])
  check('cast of Meteor Shower accepted at level 25', () => network.castAbility('pD', 5, 25), true)
  check('network cooldowns rounded to three decimals', () => {
    network.tick(8.76544)
    return network.getCooldownsForNetwork('pD')
  }, [{ abilityId: 5, remaining: 1.235 }])
  check('player info lists unlocked abilities, raw cooldown and active set', () => {
    const info = network.getPlayerAbilityInfo('pD', 25)
    return [info.unlockedAbilities.map(a => a.id), info.cooldowns.map(c => c.abilityId), Math.abs(info.cooldowns[0].remaining - 1.23456) < 1e-9, info.activeAbilities]
  }, [[1, 2, 3, 4, 5], [5], true, [5]])
  check('removePlayer clears the player state', () => {
    network.removePlayer('pD')
    const info = network.getPlayerAbilityInfo('pD', 25)
    return [network.getCooldownsForNetwork('pD'), info.cooldowns, info.activeAbilities]
  }, [[], [], []])
  check('getAllAbilities has five entries', () => network.getAllAbilities().length, 5)

  const lockedTree = createAbilityTree()
  check('canCastAbility with a level refuses a locked ability', () => [lockedTree.canCastAbility('g1', 2, 4), lockedTree.getAbilityCooldown('g1', 2)], [false, 0])
  check('canCastAbility with a level accepts an unlocked ready ability', () => createAbilityTree().canCastAbility('g1', 2, 5), true)
  check('canCastAbility without a level is cooldown readiness only', () => [createAbilityTree().canCastAbility('g1', 2), createAbilityTree().canCastAbility('g1', 1)], [true, true])
  check('canCastAbility without a level refuses a cooling ability', () => {
    const tree = createAbilityTree()
    tree.castAbility('g1', 1, 1)
    return tree.canCastAbility('g1', 1)
  }, false)
  check('castAbility and canCastAbility agree on a locked ability', () => {
    const tree = createAbilityTree()
    return [tree.canCastAbility('g1', 2, 4), tree.castAbility('g1', 2, 4), tree.canCastAbility('g1', 2, 4)]
  }, [false, false, false])
  check('castAbility and canCastAbility agree on an unlocked ability', () => {
    const tree = createAbilityTree()
    return [tree.canCastAbility('g1', 2, 5), tree.castAbility('g1', 2, 5), tree.canCastAbility('g1', 2, 5)]
  }, [true, true, false])
  check('castAbility without a level refuses a level-gated ability', () => {
    const tree = createAbilityTree()
    return [tree.castAbility('pU', 2), tree.castAbility('pU', 1), tree.getAbilityCooldown('pU', 2)]
  }, [false, false, 0])
  check('cooldown 0 is clamped to the 0.1 floor, not replaced by 1.0', () => createAbilityTree([{ id: 11, cooldown: 0 }]).getAbility(11).cooldown, 0.1)
  check('an absent cooldown still defaults to 1.0', () => createAbilityTree([{ id: 12 }]).getAbility(12).cooldown, 1)

  const coolingSource = createAbilityTree()
  coolingSource.castAbility('pX', 1, 1)
  coolingSource.tick(0.5)
  const coolingWire = JSON.parse(JSON.stringify(coolingSource.buildSnapshot()))
  check('applySnapshot restores activeAbilities from the restored cooldowns', () => {
    const restored = createAbilityTree()
    restored.applySnapshot(coolingWire)
    return restored.getPlayerAbilityInfo('pX', 1).activeAbilities
  }, [1])
  check('applySnapshot replacing cooldowns drops the stale activeAbilities', () => {
    const replaced = createAbilityTree()
    replaced.castAbility('pX', 2, 5)
    replaced.applySnapshot(coolingWire)
    return replaced.getPlayerAbilityInfo('pX', 25).activeAbilities
  }, [1])
  check('stale activeAbilities do not survive the next tick', () => {
    const replaced = createAbilityTree()
    replaced.castAbility('pX', 2, 5)
    replaced.applySnapshot(coolingWire)
    replaced.tick(5)
    return [replaced.getPlayerAbilityInfo('pX', 25).activeAbilities, replaced.getAbilityCooldown('pX', 2), replaced.getAbilityCooldown('pX', 1)]
  }, [[], 0, 0])
  check('applySnapshot refuses a hotkey bound to an unknown ability and keeps the slot', () => {
    const tree = createAbilityTree()
    tree.bindHotkey(8, 3)
    tree.applySnapshot({ hotkeys: { 7: 999, 8: 999 } })
    return [tree.getHotkeyBinding(7), tree.getHotkeyBinding(8)]
  }, [null, 3])
  check('applySnapshot binds a known ability and unbinds a slot with null', () => {
    const tree = createAbilityTree()
    tree.bindHotkey(8, 3)
    tree.applySnapshot({ hotkeys: { 7: 2, 8: null } })
    return [tree.getHotkeyBinding(7), tree.getHotkeyBinding(8)]
  }, [2, null])

  check('module source is seed-free (no Math.random, Date, performance.now or crypto randomness)', () => source.match(NONDETERMINISM) || [], [])

  runProperties(mod, check)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function runProperties(mod, check) {
  const { createAbilityTree } = mod
  const rand = mulberry32(0x5eed1234)
  const PLAYERS = ['pR0', 'pR1']
  const ABILITY_IDS = [1, 2, 3, 4, 5]
  const pick = (list) => list[Math.floor(rand() * list.length)]

  const observable = (tree, level) => JSON.stringify({
    hotkeys: tree.getAllHotkeyBindings(),
    players: PLAYERS.map(id => {
      const info = tree.getPlayerAbilityInfo(id, level)
      return [
        info.cooldowns.map(c => [c.abilityId, c.remaining]).sort((a, b) => a[0] - b[0]),
        info.activeAbilities.slice().sort()
      ]
    })
  })

  const cooldownTable = (tree) => {
    const table = []
    for (const playerId of PLAYERS) {
      for (const abilityId of ABILITY_IDS) table.push(tree.getAbilityCooldown(playerId, abilityId))
    }
    return table
  }

  const grew = []
  const partial = []
  const activeDrift = []
  const roundTrip = []
  const expiry = []

  for (let trial = 0; trial < 200; trial++) {
    const level = 1 + Math.floor(rand() * 29)
    const tree = createAbilityTree()
    for (let step = 0; step < 6; step++) {
      if (rand() < 0.4) {
        tree.bindHotkey(1 + Math.floor(rand() * 9), pick([...ABILITY_IDS, null]))
      }
      if (rand() < 0.5) {
        const playerId = pick(PLAYERS)
        const abilityId = pick([...ABILITY_IDS, 99])
        const before = observable(tree, level)
        const accepted = tree.castAbility(playerId, abilityId, level)
        if (!accepted && observable(tree, level) !== before) partial.push([trial, step, abilityId])
      } else {
        const dt = rand() * 6 - 3
        const before = cooldownTable(tree)
        tree.tick(dt)
        const after = cooldownTable(tree)
        for (let i = 0; i < before.length; i++) if (after[i] > before[i]) grew.push([trial, step, dt])
      }
      for (const playerId of PLAYERS) {
        const info = tree.getPlayerAbilityInfo(playerId, level)
        const cooling = info.cooldowns.filter(c => c.remaining > 0).map(c => c.abilityId).sort().join(',')
        if (cooling !== info.activeAbilities.slice().sort().join(',')) activeDrift.push([trial, step, playerId])
      }
    }

    const wire = JSON.parse(JSON.stringify(tree.buildSnapshot()))
    const restored = createAbilityTree()
    const result = restored.applySnapshot(wire)
    if (!result.ok || result.dropped.length > 0 || observable(restored, level) !== observable(tree, level)) {
      roundTrip.push([trial, result.dropped.length])
    }
    restored.applySnapshot(wire)
    if (observable(restored, level) !== observable(tree, level)) roundTrip.push([trial, 'not-idempotent'])

    const spentWire = JSON.parse(JSON.stringify(tree.buildSnapshot()))
    for (const state of spentWire.playerStates) {
      for (const entry of state.cooldowns) entry[1] = 0
    }
    const spent = createAbilityTree()
    spent.applySnapshot(spentWire)
    for (const playerId of PLAYERS) {
      const info = spent.getPlayerAbilityInfo(playerId, level)
      const cooling = info.cooldowns.filter(c => c.remaining > 0).map(c => c.abilityId).sort().join(',')
      if (cooling !== info.activeAbilities.slice().sort().join(',')) activeDrift.push([trial, 'spent-wire', playerId])
    }
  }

  for (let trial = 0; trial < 60; trial++) {
    const tree = createAbilityTree()
    const abilityId = pick(ABILITY_IDS)
    const cooldown = tree.getAbility(abilityId).cooldown
    if (!tree.castAbility('pE', abilityId, 25)) {
      expiry.push([trial, 'refused'])
      continue
    }
    let elapsed = 0
    let ticks = 0
    while (tree.getAbilityCooldown('pE', abilityId) > 0 && ticks < 200) {
      const dt = rand() * 1.5
      tree.tick(dt)
      elapsed += dt
      ticks++
    }
    const info = tree.getPlayerAbilityInfo('pE', 25)
    if (!(tree.getAbilityCooldown('pE', abilityId) === 0 && info.activeAbilities.length === 0 && tree.canCastAbility('pE', abilityId, 25))) {
      expiry.push([trial, abilityId, elapsed])
    }
  }

  check('property: tick never grows a cooldown, dt in [-3,3), 200 trials x 6 steps', () => grew.length, 0)
  check('property: a refused cast mutates nothing, 200 trials', () => partial.length, 0)
  check('property: activeAbilities is exactly the running cooldowns, 200 trials', () => activeDrift.length, 0)
  check('property: buildSnapshot round-trips and applies idempotently, 200 trials', () => roundTrip.length, 0)
  check('property: every cast cooldown expires in finite elapsed time, 60 trials', () => expiry.length, 0)
}

async function evaluate(modulePath, emit) {
  const bytes = readFileSync(modulePath)
  const source = bytes.toString('utf8')
  emit(`module_sha256: ${sha256(bytes)}`)
  let mod
  try {
    mod = await import(pathToFileURL(modulePath).href)
  } catch (error) {
    return { ok: false, detail: `module import failed: ${error && error.message}` }
  }
  const nondeterministic = [...new Set(source.match(NONDETERMINISM) || [])]
  emit(nondeterministic.length === 0
    ? 'determinism: module uses no Math.random, Date, performance.now or crypto randomness; no seed is injected'
    : `determinism: module uses ${nondeterministic.join(', ')}; this witness injects no seed, so the seed-free check fails`)
  const ledger = createLedger()
  try {
    runSuite(mod, ledger.record, source)
  } catch (error) {
    ledger.failed.push(`suite aborted: ${error && error.message}`)
  }
  ledger.lines.forEach(emit)
  const total = ledger.total()
  emit(`checks: ${total - ledger.failed.length} of ${total} passed`)
  if (ledger.failed.length > 0) return { ok: false, detail: `failed checks: ${ledger.failed.join('; ')}` }
  return { ok: total > 0 }
}

async function decide(options, modulePath, outPath, emit) {
  if (options.unknown.length > 0) {
    return { ok: false, outRefused: true, detail: `unknown argument(s): ${options.unknown.join(' ')}; accepted: --module=, --out=, --log=` }
  }
  if (outPath && existsSync(outPath)) {
    return { ok: false, outRefused: true, detail: `--out is create-only and already exists: ${outPath}` }
  }
  if (!existsSync(modulePath)) {
    return { ok: false, detail: `module not found: ${modulePath}` }
  }
  return evaluate(modulePath, emit)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const modulePath = resolve(options.module)
  const outPath = options.out ? resolve(options.out) : null
  const logPath = options.log ? resolve(options.log) : null
  const body = [WITNESS, `ts: ${new Date().toISOString()}`, `module: ${modulePath}`]
  const emit = (line) => body.push(line)
  const verdict = await decide(options, modulePath, outPath, emit)
  if (!verdict.ok && verdict.detail) emit(`reason: ${verdict.detail}`)
  let exitCode = verdict.ok ? 0 : 1
  let outNote = 'none'
  let text = [...body, `RESULT: ${verdict.ok ? 'PASS' : 'FAIL'}`].join('\n') + '\n'
  if (outPath && !verdict.outRefused) {
    try {
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, text, { flag: 'wx' })
      outNote = outPath
    } catch (error) {
      exitCode = 1
      outNote = 'not-written'
      text = [...body, `reason: could not create --out: ${error && error.message}`, 'RESULT: FAIL'].join('\n') + '\n'
    }
  }
  process.stdout.write(text)
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${new Date().toISOString()} | ${WITNESS} | module=${modulePath} | out=${outNote} | exit=${exitCode} | RESULT: ${exitCode === 0 ? 'PASS' : 'FAIL'}\n`)
  }
  process.exitCode = exitCode
}

await main()
