import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WITNESS = 'AbilityTree-witness'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODULE = resolve(REPO_ROOT, 'src', 'game', 'AbilityTree.js')
const NONDETERMINISM = /Math\.random|\bDate\b|performance\.now|crypto\.getRandomValues|crypto\.randomUUID/g

const SLOT_KEY_PATTERN = /^[1-9]$/
const PLAYER_ENTRY_PATTERN = /^playerStates\[\d+\](\.playerId|\.cooldowns)?$/

const ALT_ABILITIES = [
  { id: 11, name: 'Dash', description: 'Dash forward', manaCost: 5, cooldown: 1.5, unlockLevel: 3, damage: 0 },
  { id: 12, name: 'Shield', description: 'Block the next hit', manaCost: 12, cooldown: 6, unlockLevel: 8, damage: 0 },
  { id: 13, name: 'Quake', description: 'Shatter the ground in a ring', manaCost: 44, cooldown: 9.25, unlockLevel: 20, damage: 55 }
]

const MALFORMED_ABILITIES = [
  { id: 21, name: 'Valid', cooldown: 2, unlockLevel: 1, damage: 3 },
  { name: 'no id' },
  { id: 0, name: 'zero id' },
  { id: '22', name: 'string id' },
  { id: 21.5, name: 'fractional id' },
  42,
  null,
  [21],
  { id: 21, name: 'duplicate of 21' },
  { id: 23, name: 'second valid', cooldown: 0, unlockLevel: 2, damage: 1 }
]

const INVARIANT_CONFIGS = [
  { label: 'default/a11ce', defs: 'default', seed: 0xa11ce },
  { label: 'default/1f2e3d', defs: 'default', seed: 0x1f2e3d },
  { label: 'default/c0ffee', defs: 'default', seed: 0x00c0ffee },
  { label: 'alt/a11ce', defs: 'alt', seed: 0xa11ce },
  { label: 'alt/1f2e3d', defs: 'alt', seed: 0x1f2e3d },
  { label: 'malformed/a11ce', defs: 'malformed', seed: 0xa11ce },
  { label: 'malformed/c0ffee', defs: 'malformed', seed: 0x00c0ffee }
]

function expectedDefinitionRefusals(defs) {
  if (!Array.isArray(defs)) return [{ index: null, field: 'definitions', reason: 'definitions-not-an-array' }]
  const out = []
  const seen = new Set()
  defs.forEach((def, index) => {
    const field = `definitions[${index}]`
    if (def === null || typeof def !== 'object' || Array.isArray(def)) {
      out.push({ index, field, reason: 'not-an-object' })
      return
    }
    if (def.id === null || def.id === undefined) {
      out.push({ index, field, reason: 'id-missing' })
      return
    }
    if (!Number.isInteger(def.id) || def.id <= 0) {
      out.push({ index, field, reason: 'id-not-a-positive-integer' })
      return
    }
    if (seen.has(def.id)) {
      out.push({ index, field, reason: 'duplicate-id' })
      return
    }
    seen.add(def.id)
  })
  return out
}

function expectedDropped(knownIds, wire) {
  if (!wire || typeof wire !== 'object') return null
  const dropped = []
  const hotkeysIn = wire.hotkeys
  const hotkeysUsable = hotkeysIn !== undefined && hotkeysIn !== null && typeof hotkeysIn === 'object' && !Array.isArray(hotkeysIn)
  if (hotkeysIn !== undefined && hotkeysIn !== null && !hotkeysUsable) dropped.push({ field: 'hotkeys', reason: 'hotkeys-not-an-object' })
  if (hotkeysUsable) {
    for (const [slotKey, abilityId] of Object.entries(hotkeysIn)) {
      if (!SLOT_KEY_PATTERN.test(slotKey)) {
        dropped.push({ field: `hotkeys.${slotKey}`, reason: 'slot-out-of-range' })
        continue
      }
      if (abilityId !== null && !knownIds.has(abilityId)) {
        dropped.push({ field: `hotkeys.${slotKey}`, reason: 'unknown-ability' })
        continue
      }
    }
  }
  const statesIn = wire.playerStates
  const statesUsable = Array.isArray(statesIn)
  if (statesIn !== undefined && statesIn !== null && !statesUsable) dropped.push({ field: 'playerStates', reason: 'player-states-not-an-array' })
  if (statesUsable) {
    const seenPlayers = new Set()
    statesIn.forEach((snap, playerIndex) => {
      if (!snap || !snap.playerId) {
        dropped.push({ field: `playerStates[${playerIndex}].playerId`, reason: 'missing' })
        return
      }
      if (seenPlayers.has(snap.playerId)) {
        dropped.push({ field: `playerStates[${playerIndex}].playerId`, reason: 'duplicate-player' })
        return
      }
      seenPlayers.add(snap.playerId)
      if (!Array.isArray(snap.cooldowns)) {
        dropped.push({ field: `playerStates[${playerIndex}].cooldowns`, reason: 'not-an-array' })
        return
      }
      snap.cooldowns.forEach((entry, entryIndex) => {
        if (!Array.isArray(entry)) {
          dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}]`, reason: 'not-an-array' })
          return
        }
        const abilityId = parseInt(entry[0], 10)
        if (!Number.isFinite(abilityId)) {
          dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}].abilityId`, reason: 'not-a-number' })
          return
        }
        if (!knownIds.has(abilityId)) {
          dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}].abilityId`, reason: 'unknown-ability' })
          return
        }
        if (!(typeof entry[1] === 'number' && Number.isFinite(entry[1]))) {
          dropped.push({ field: `playerStates[${playerIndex}].cooldowns[${entryIndex}].cooldown`, reason: 'not-a-number' })
        }
      })
    })
  }
  return dropped
}

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

  const malformed = createAbilityTree(MALFORMED_ABILITIES)
  check('each malformed definition is refused with a named reason at the parse boundary', () => malformed.getDefinitionRefusals(), [
    { index: 1, field: 'definitions[1]', reason: 'id-missing' },
    { index: 2, field: 'definitions[2]', reason: 'id-not-a-positive-integer' },
    { index: 3, field: 'definitions[3]', reason: 'id-not-a-positive-integer' },
    { index: 4, field: 'definitions[4]', reason: 'id-not-a-positive-integer' },
    { index: 5, field: 'definitions[5]', reason: 'not-an-object' },
    { index: 6, field: 'definitions[6]', reason: 'not-an-object' },
    { index: 7, field: 'definitions[7]', reason: 'not-an-object' },
    { index: 8, field: 'definitions[8]', reason: 'duplicate-id' }
  ])
  check('a refused definition is not registered and the valid ones are', () => malformed.getAllAbilities().map(a => a.id), [21, 23])
  check('a definition list that is not an array is refused as a whole', () => createAbilityTree('nope').getDefinitionRefusals(), [{ index: null, field: 'definitions', reason: 'definitions-not-an-array' }])
  check('a non-array definition list registers no ability', () => [createAbilityTree('nope').getAllAbilities(), createAbilityTree(undefined).getAllAbilities().length], [[], 5])
  check('the returned refusal list is a copy of the recorded refusals', () => {
    const view = malformed.getDefinitionRefusals()
    view.push({ index: 9, field: 'definitions[9]', reason: 'forged' })
    view[0].reason = 'rewritten'
    return malformed.getDefinitionRefusals().length
  }, 8)
  check('a hotkey map that is not an object is refused, not silently ignored', () => {
    const tree = createAbilityTree()
    tree.bindHotkey(8, 3)
    const result = tree.applySnapshot({ hotkeys: 'nope' })
    return [result.dropped, result.hotkeys, tree.getHotkeyBinding(8)]
  }, [[{ field: 'hotkeys', reason: 'hotkeys-not-an-object' }], 0, 3])
  check('playerStates that is not an array is refused, not silently ignored', () => {
    const tree = createAbilityTree()
    tree.castAbility('pQ', 1, 1)
    const result = tree.applySnapshot({ playerStates: { pQ: [[1, 9]] } })
    return [result.dropped, result.players, tree.getAbilityCooldown('pQ', 1)]
  }, [[{ field: 'playerStates', reason: 'player-states-not-an-array' }], 0, 2])
  check('a repeated player in one snapshot is refused with a named reason', () => {
    const tree = createAbilityTree()
    const result = tree.applySnapshot({ playerStates: [{ playerId: 'pR', cooldowns: [[1, 4]] }, { playerId: 'pR', cooldowns: [[1, 1]] }] })
    return [result.dropped, result.players, tree.getAbilityCooldown('pR', 1)]
  }, [[{ field: 'playerStates[1].playerId', reason: 'duplicate-player' }], 1, 4])
  check('a cooldown entry that is not an array is refused with a named reason', () => {
    const tree = createAbilityTree()
    const result = tree.applySnapshot({ playerStates: [{ playerId: 'pS', cooldowns: [[1, 4], null, ['x', 1], [1, 'y'], [99, 2]] }] })
    return [result.dropped, result.players, tree.getAbilityCooldown('pS', 1)]
  }, [[
    { field: 'playerStates[0].cooldowns[1]', reason: 'not-an-array' },
    { field: 'playerStates[0].cooldowns[2].abilityId', reason: 'not-a-number' },
    { field: 'playerStates[0].cooldowns[3].cooldown', reason: 'not-a-number' },
    { field: 'playerStates[0].cooldowns[4].abilityId', reason: 'unknown-ability' }
  ], 1, 4])
  check('a hotkey slot key that is not one digit 1-9 is refused, not parsed loosely', () => {
    const tree = createAbilityTree()
    tree.bindHotkey(3, 1)
    const result = tree.applySnapshot({ hotkeys: { '3abc': 4, 0: 1, 10: 2, 7: 2 } })
    return [result.dropped, result.hotkeys, tree.getHotkeyBinding(3), tree.getHotkeyBinding(7)]
  }, [[
    { field: 'hotkeys.0', reason: 'slot-out-of-range' },
    { field: 'hotkeys.10', reason: 'slot-out-of-range' },
    { field: 'hotkeys.3abc', reason: 'slot-out-of-range' }
  ], 1, 1, 2])

  const altHotkeys = createAbilityTree(ALT_ABILITIES)
  check('a default hotkey slot whose ability is absent from the table is refused, not bound to a missing ability', () => [altHotkeys.getHotkeyRefusals(), altHotkeys.getAllHotkeyBindings()], [
    [
      { field: 'hotkeys.1', reason: 'unknown-ability' },
      { field: 'hotkeys.2', reason: 'unknown-ability' },
      { field: 'hotkeys.3', reason: 'unknown-ability' },
      { field: 'hotkeys.4', reason: 'unknown-ability' },
      { field: 'hotkeys.5', reason: 'unknown-ability' }
    ],
    { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null }
  ])
  check('a hotkey map with an out-of-range slot is refused at construction', () => createAbilityTree(DEFAULT_ABILITIES, { 1: 1, 12: 3, '3abc': 2 }).getHotkeyRefusals(), [
    { field: 'hotkeys.12', reason: 'slot-out-of-range' },
    { field: 'hotkeys.3abc', reason: 'slot-out-of-range' }
  ])
  check('a tree built from its own table round-trips its hotkeys through a snapshot', () => {
    const restored = createAbilityTree(ALT_ABILITIES)
    restored.bindHotkey(1, 11)
    const result = createAbilityTree(ALT_ABILITIES).applySnapshot(restored.buildSnapshot())
    return [result.dropped, result.hotkeys]
  }, [[], 9])

  check('module source is seed-free (no Math.random, Date, performance.now or crypto randomness)', () => source.match(NONDETERMINISM) || [], [])

  runProperties(mod, check)
  runInvariantRun(mod, check)
}

function runInvariantRun(mod, check) {
  const { DEFAULT_ABILITIES, HOTKEY_MAP, createAbilityTree } = mod
  const TABLES = { default: DEFAULT_ABILITIES, alt: ALT_ABILITIES, malformed: MALFORMED_ABILITIES }
  const PLAYERS = ['p0', 'p1', 'p2']
  const LEVEL_CHOICES = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, undefined, NaN, null]
  const DT_CHOICES = [0, 0.001, 0.1, 0.25, 1 / 3, 0.5, 1, 1.5, 2.5, 7, 1e3, -1, NaN, Infinity]
  const violations = { drift: [], tick: [], cast: [], gate: [], restored: [], hotkeys: [], survivor: [], removed: [], unspent: [], disagree: [], unlocked: [], trip: [], dropped: [], account: [], definitions: [], construction: [] }
  const note = (bucket, detail) => violations[bucket].push(detail)

  const activeOf = (tree, playerId) => [...tree.getPlayerAbilityState(playerId).activeAbilities].sort().join(',')
  const coolingOf = (tree, playerId, abilityIds) => abilityIds.filter(abilityId => tree.getAbilityCooldown(playerId, abilityId) > 0).join(',')
  const acceptedEntries = (snap, knownIds) => {
    const accepted = new Map()
    for (const entry of snap.cooldowns) {
      if (!Array.isArray(entry)) continue
      const abilityId = parseInt(entry[0], 10)
      if (!Number.isFinite(abilityId) || !knownIds.has(abilityId)) continue
      if (!(typeof entry[1] === 'number' && Number.isFinite(entry[1]))) continue
      accepted.set(abilityId, entry[1])
    }
    return accepted
  }
  const observable = (tree, level) => JSON.stringify({
    hotkeys: tree.getAllHotkeyBindings(),
    players: PLAYERS.map(playerId => {
      const info = tree.getPlayerAbilityInfo(playerId, level)
      return [
        info.cooldowns.map(entry => [entry.abilityId, entry.remaining]).sort((a, b) => a[0] - b[0]),
        info.activeAbilities.slice().sort()
      ]
    })
  })

  for (const config of INVARIANT_CONFIGS) {
    const defs = TABLES[config.defs]
    const rand = mulberry32(config.seed)
    const pick = list => list[Math.floor(rand() * list.length)]

    const probe = createAbilityTree(defs)
    const wantRefusals = expectedDefinitionRefusals(defs)
    const gotRefusals = typeof probe.getDefinitionRefusals === 'function' ? probe.getDefinitionRefusals() : 'getDefinitionRefusals-missing'
    if (JSON.stringify(gotRefusals) !== JSON.stringify(wantRefusals)) {
      note('definitions', [config.label, JSON.stringify(gotRefusals), JSON.stringify(wantRefusals)])
    }

    const ABILITIES = probe.getAllAbilities()
    const ABILITY_IDS = ABILITIES.map(ability => ability.id)
    const COOLDOWN = new Map(ABILITIES.map(ability => [ability.id, ability.cooldown]))
    const UNLOCK = new Map(ABILITIES.map(ability => [ability.id, ability.unlockLevel]))
    const KNOWN = new Set(COOLDOWN.keys())
    const wantHotkeyRefusals = Object.entries(HOTKEY_MAP)
      .filter(([, abilityId]) => abilityId !== null && !KNOWN.has(abilityId))
      .map(([slotKey]) => ({ field: `hotkeys.${slotKey}`, reason: 'unknown-ability' }))
    const gotHotkeyRefusals = typeof probe.getHotkeyRefusals === 'function' ? probe.getHotkeyRefusals() : 'getHotkeyRefusals-missing'
    if (JSON.stringify(gotHotkeyRefusals) !== JSON.stringify(wantHotkeyRefusals)) {
      note('construction', [config.label, JSON.stringify(gotHotkeyRefusals), JSON.stringify(wantHotkeyRefusals)])
    }
    const cooldownTable = tree => {
      const table = []
      for (const playerId of PLAYERS) {
        for (const abilityId of ABILITY_IDS) table.push(tree.getAbilityCooldown(playerId, abilityId))
      }
      return table
    }

    for (let trial = 0; trial < 300; trial++) {
      const tree = createAbilityTree(defs)
      const level = pick(LEVEL_CHOICES)
      const owed = new Map()

      for (let step = 0; step < 40; step++) {
        const roll = rand()

        if (roll < 0.3) {
          const playerId = pick(PLAYERS)
          const abilityId = pick([...ABILITY_IDS, 99])
          const before = cooldownTable(tree)
          const wantAccepted = Number.isFinite(level) && UNLOCK.get(abilityId) <= level && tree.getAbilityCooldown(playerId, abilityId) <= 0
          const accepted = tree.castAbility(playerId, abilityId, level)
          const after = cooldownTable(tree)
          if (accepted !== wantAccepted) note('gate', [config.label, trial, step, playerId, abilityId, String(level), accepted, wantAccepted])
          if (accepted) {
            if (tree.getAbilityCooldown(playerId, abilityId) !== COOLDOWN.get(abilityId)) {
              note('cast', [config.label, trial, step, playerId, abilityId, tree.getAbilityCooldown(playerId, abilityId)])
            }
            if (!tree.getPlayerAbilityState(playerId).activeAbilities.has(abilityId)) note('cast', [config.label, trial, step, playerId, abilityId, 'no-active'])
            owed.set(`${playerId}:${abilityId}`, { cooldown: COOLDOWN.get(abilityId), elapsed: 0 })
          } else if (JSON.stringify(before) !== JSON.stringify(after)) {
            note('cast', [config.label, trial, step, playerId, abilityId, 'refused-mutated'])
          }
        } else if (roll < 0.58) {
          const dt = pick(DT_CHOICES)
          const before = cooldownTable(tree)
          const beforeActive = PLAYERS.map(playerId => activeOf(tree, playerId)).join('|')
          tree.tick(dt)
          const after = cooldownTable(tree)
          const applies = typeof dt === 'number' && Number.isFinite(dt) && dt >= 0
          for (let i = 0; i < before.length; i++) {
            if (applies) {
              const want = Math.max(0, before[i] - dt)
              if (after[i] !== want) note('tick', [config.label, trial, step, dt, i, before[i], after[i], want])
            } else if (after[i] !== before[i]) {
              note('tick', [config.label, trial, step, String(dt), i, before[i], after[i], 'invalid-dt-mutated'])
            }
          }
          if (!applies && PLAYERS.map(playerId => activeOf(tree, playerId)).join('|') !== beforeActive) {
            note('tick', [config.label, trial, step, String(dt), 'invalid-dt-moved-active'])
          }
          if (applies) for (const record of owed.values()) record.elapsed += dt
        } else if (roll < 0.72) {
          const wire = JSON.parse(JSON.stringify(tree.buildSnapshot()))
          const mode = pick(['full', 'drop-player', 'unknown', 'stale', 'malformed', 'hotkeys-not-an-object', 'hotkeys-array', 'states-not-an-array', 'null-entry', 'dup-player'])
          if (mode === 'drop-player') wire.playerStates = wire.playerStates.filter(state => state.playerId !== pick(PLAYERS))
          if (mode === 'unknown') for (const state of wire.playerStates) state.cooldowns.push([99, 3], ['x', 1], [1, 'y'])
          if (mode === 'stale') wire.playerStates = [{ playerId: pick(PLAYERS), cooldowns: [[pick(ABILITY_IDS), 0], [pick(ABILITY_IDS), 1.5]] }]
          if (mode === 'dup-player') wire.playerStates = wire.playerStates.concat(JSON.parse(JSON.stringify(wire.playerStates.slice(0, 1))))
          if (mode === 'null-entry') for (const state of wire.playerStates) state.cooldowns.push(null)
          if (mode === 'malformed') {
            wire.playerStates = wire.playerStates.concat([{ playerId: 0 }, { cooldowns: 'nope' }, { playerId: 'p9', cooldowns: [] }])
            wire.hotkeys = { ...wire.hotkeys, 0: 1, 10: 2, '3abc': 4, 5: 99 }
          }
          if (mode === 'hotkeys-not-an-object') wire.hotkeys = 'nope'
          if (mode === 'hotkeys-array') wire.hotkeys = [1, 2]
          if (mode === 'states-not-an-array') wire.playerStates = { p0: [[pick(ABILITY_IDS), 1]] }
          const statesUsable = Array.isArray(wire.playerStates)
          const hotkeysUsable = wire.hotkeys !== undefined && wire.hotkeys !== null && typeof wire.hotkeys === 'object' && !Array.isArray(wire.hotkeys)
          const absent = PLAYERS.filter(playerId => !(statesUsable && wire.playerStates.some(state => state && state.playerId === playerId)))
          const beforeAbsent = absent.map(playerId => JSON.stringify([...tree.getPlayerAbilityState(playerId).cooldowns]))
          const beforeHotkeys = tree.getAllHotkeyBindings()
          const result = tree.applySnapshot(wire)
          if (!result.ok) note('restored', [config.label, trial, step, mode, result.reason])

          const wantDropped = expectedDropped(KNOWN, wire)
          if (JSON.stringify(result.dropped) !== JSON.stringify(wantDropped)) {
            note('dropped', [config.label, trial, step, mode, JSON.stringify(result.dropped), JSON.stringify(wantDropped)])
          }
          const inputHotkeys = wire.hotkeys === undefined || wire.hotkeys === null ? 0 : (hotkeysUsable ? Object.keys(wire.hotkeys).length : 1)
          const droppedHotkeys = result.dropped.filter(entry => entry.field === 'hotkeys' || entry.field.startsWith('hotkeys.')).length
          if (result.hotkeys + droppedHotkeys !== inputHotkeys) {
            note('account', [config.label, trial, step, mode, 'hotkeys', result.hotkeys, droppedHotkeys, inputHotkeys])
          }
          const inputPlayers = wire.playerStates === undefined || wire.playerStates === null ? 0 : (statesUsable ? wire.playerStates.length : 1)
          const droppedPlayers = result.dropped.filter(entry => entry.field === 'playerStates' || PLAYER_ENTRY_PATTERN.test(entry.field)).length
          if (result.players + droppedPlayers !== inputPlayers) {
            note('account', [config.label, trial, step, mode, 'players', result.players, droppedPlayers, inputPlayers])
          }

          const wantHotkeys = { ...beforeHotkeys }
          if (hotkeysUsable) {
            for (const [slotKey, abilityId] of Object.entries(wire.hotkeys)) {
              if (!SLOT_KEY_PATTERN.test(slotKey)) continue
              if (abilityId !== null && !COOLDOWN.has(abilityId)) continue
              wantHotkeys[slotKey] = abilityId
            }
          }
          const gotHotkeys = tree.getAllHotkeyBindings()
          for (const slot of Object.keys({ ...wantHotkeys, ...gotHotkeys })) {
            if ((wantHotkeys[slot] ?? null) !== (gotHotkeys[slot] ?? null)) {
              note('hotkeys', [config.label, trial, step, mode, slot, wantHotkeys[slot] ?? null, gotHotkeys[slot] ?? null])
            }
          }
          const seenPlayers = new Set()
          for (const snap of statesUsable ? wire.playerStates : []) {
            if (!snap || !snap.playerId || !Array.isArray(snap.cooldowns)) continue
            if (seenPlayers.has(snap.playerId)) continue
            seenPlayers.add(snap.playerId)
            const got = [...tree.getPlayerAbilityState(snap.playerId).cooldowns.entries()].sort((a, b) => a[0] - b[0])
            const want = [...acceptedEntries(snap, KNOWN).entries()].sort((a, b) => a[0] - b[0])
            if (JSON.stringify(got) !== JSON.stringify(want)) note('restored', [config.label, trial, step, mode, snap.playerId, JSON.stringify(got), JSON.stringify(want)])
          }
          for (const playerId of seenPlayers) {
            for (const key of [...owed.keys()]) if (key.startsWith(`${playerId}:`)) owed.delete(key)
            for (const [abilityId, remaining] of tree.getPlayerAbilityState(playerId).cooldowns) {
              owed.set(`${playerId}:${abilityId}`, { cooldown: remaining, elapsed: 0 })
            }
          }
          absent.forEach((playerId, index) => {
            const now = JSON.stringify([...tree.getPlayerAbilityState(playerId).cooldowns])
            if (now !== beforeAbsent[index]) note('survivor', [config.label, trial, step, mode, playerId, beforeAbsent[index], now])
          })
        } else if (roll < 0.8) {
          const playerId = pick(PLAYERS)
          tree.removePlayer(playerId)
          if (tree.getCooldownsForNetwork(playerId).length !== 0) note('removed', [config.label, trial, step, playerId])
          for (const key of [...owed.keys()]) if (key.startsWith(`${playerId}:`)) owed.delete(key)
        } else if (roll < 0.9) {
          const slot = 1 + Math.floor(rand() * 9)
          const abilityId = pick([...ABILITY_IDS, null])
          const wantBound = abilityId === null || COOLDOWN.has(abilityId)
          if (tree.bindHotkey(slot, abilityId) !== wantBound) note('gate', [config.label, trial, step, slot, abilityId, 'bind'])
        } else {
          const playerId = pick(PLAYERS)
          const abilityId = pick(ABILITY_IDS)
          const predicted = tree.canCastAbility(playerId, abilityId, level)
          const accepted = tree.castAbility(playerId, abilityId, level)
          const want = Number.isFinite(level) ? accepted : tree.getAbilityCooldown(playerId, abilityId) === 0
          if (predicted !== want) note('disagree', [config.label, trial, step, playerId, abilityId, String(level), predicted, want])
        }

        for (const playerId of PLAYERS) {
          const active = activeOf(tree, playerId)
          if (active !== coolingOf(tree, playerId, ABILITY_IDS)) note('drift', [config.label, trial, step, playerId, active, coolingOf(tree, playerId, ABILITY_IDS)])
        }

        if (Number.isFinite(level)) {
          const wantUnlocked = ABILITY_IDS.filter(abilityId => UNLOCK.get(abilityId) <= level).join(',')
          const gotUnlocked = tree.getUnlockedAbilities(level).map(ability => ability.id).join(',')
          if (gotUnlocked !== wantUnlocked) note('unlocked', [config.label, trial, step, level, gotUnlocked, wantUnlocked])
        }

        for (const [key, record] of owed) {
          const [playerId, abilityId] = key.split(':')
          const remaining = tree.getAbilityCooldown(playerId, Number(abilityId))
          if (record.elapsed >= record.cooldown && remaining !== 0) note('unspent', [config.label, trial, step, key, record.cooldown, record.elapsed, remaining])
          if (remaining === 0) owed.delete(key)
        }
      }

      const wire = JSON.parse(JSON.stringify(tree.buildSnapshot()))
      const restored = createAbilityTree(defs)
      const result = restored.applySnapshot(wire)
      if (!result.ok || result.dropped.length > 0 || observable(restored, level) !== observable(tree, level)) {
        note('trip', [config.label, trial, result.dropped.length, 'round-trip'])
      }
      restored.applySnapshot(wire)
      if (observable(restored, level) !== observable(tree, level)) note('trip', [config.label, trial, 'not-idempotent'])
    }
  }

  const report = bucket => [violations[bucket].length, violations[bucket][0] ?? null]
  const CONFIGS = `${INVARIANT_CONFIGS.length} configs (3 seeds x default+alt, 2 seeds x malformed)`
  check(`invariant run: applySnapshot's dropped list is exactly the refused entries, ${CONFIGS} x 300 trials x 40 steps`, () => report('dropped'), [0, null])
  check('invariant run: hotkeys + dropped hotkey entries and players + dropped player entries account for the whole input', () => report('account'), [0, null])
  check('invariant run: a malformed ability definition is refused with a named reason at the parse boundary', () => report('definitions'), [0, null])
  check('invariant run: a default hotkey bound to an ability absent from the table is refused at construction', () => report('construction'), [0, null])
  check(`invariant run: activeAbilities is exactly the running cooldowns, ${CONFIGS} x 300 trials x 40 steps`, () => report('drift'), [0, null])
  check('invariant run: tick moves every player cooldown by exactly dt and ignores an invalid dt', () => report('tick'), [0, null])
  check('invariant run: an accepted cast sets one cooldown, a refused cast moves nothing', () => report('cast'), [0, null])
  check('invariant run: cast and bind accept exactly what the ability table allows', () => report('gate'), [0, null])
  check('invariant run: applySnapshot leaves a restored player at exactly the accepted entries', () => report('restored'), [0, null])
  check('invariant run: applySnapshot rebinds only the slots the snapshot may bind', () => report('hotkeys'), [0, null])
  check('invariant run: players absent from a snapshot keep their cooldowns', () => report('survivor'), [0, null])
  check('invariant run: removePlayer leaves no cooldown behind', () => report('removed'), [0, null])
  check('invariant run: a cooldown is free once the elapsed dt reaches it', () => report('unspent'), [0, null])
  check('invariant run: canCastAbility predicts castAbility, and reads readiness at an unparsed level', () => report('disagree'), [0, null])
  check('invariant run: getUnlockedAbilities is exactly the abilities unlocked at the level', () => report('unlocked'), [0, null])
  check('invariant run: buildSnapshot round-trips and reapplies after a long sequence', () => report('trip'), [0, null])
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
