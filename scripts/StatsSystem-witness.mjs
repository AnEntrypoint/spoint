import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultModule = resolve(repoRoot, 'src', 'game', 'StatsSystem.js')
const startedAt = new Date().toISOString()

const flags = {}
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg)
  if (match) flags[match[1]] = match[2] === undefined ? true : match[2]
}
const modulePath = typeof flags.module === 'string' ? resolve(repoRoot, flags.module) : defaultModule
const outPath = typeof flags.out === 'string' ? resolve(repoRoot, flags.out) : null
const logPath = typeof flags.log === 'string' ? resolve(repoRoot, flags.log) : null
const variant = typeof flags.variant === 'string' ? flags.variant : 'honest'

const lines = []
let passed = 0
let failed = 0

const record = (ok, text) => {
  if (ok) passed += 1
  else failed += 1
  lines.push((ok ? 'ok - ' : 'not ok - ') + text)
}

const check = (name, actual, expected) => {
  const ok = isDeepStrictEqual(actual, expected)
  record(ok, ok ? name : `${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
}

const scenario = (label, body) => {
  try {
    body()
  } catch (error) {
    record(false, `${label} threw: ${error.message}`)
  }
}

const thrownBy = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return { name: error.name, message: error.message }
  }
}

const makeCtx = () => {
  const sent = []
  const warns = []
  return {
    sent,
    warns,
    players: { send: (pid, msg) => { sent.push({ pid, msg }) } },
    debug: { warn: (msg) => { warns.push(msg) } },
  }
}

const equipmentSpec = {
  weapon: [
    { id: 'sword', name: 'Sword', bonuses: { damage: 5 } },
    { id: 'axe', name: 'Axe', bonuses: { damage: 8 } },
  ],
  armor: [{ id: 'plate', name: 'Plate', bonuses: { defense: 3, health: 20 } }],
  relic: [{ id: 'relic', name: 'Relic', bonuses: { crit: 4 } }],
  charm: [{ id: 'charm', name: 'Charm' }],
  broken: [null, 'text', { name: 'no id' }],
  ring: { id: 'ring-not-array', name: 'Ring', bonuses: { mana: 1 } },
}

let mod = null
if (!existsSync(modulePath)) {
  record(false, `module path exists: ${modulePath}`)
} else {
  try {
    mod = await import(pathToFileURL(modulePath).href)
  } catch (error) {
    record(false, `module imports cleanly: ${error.message}`)
  }
}

const define = mod && typeof mod.defineStatsSystem === 'function' ? mod.defineStatsSystem : null
if (mod && !define) record(false, 'module exports defineStatsSystem as a function')

if (define) {
  scenario('defaults', () => {
    const ctx = makeCtx()
    const s = define({}, ctx)
    check('spec defaults to an empty object', define(undefined, makeCtx()).getStats(1).health, 100)
    check('missing appCtx throws a TypeError', thrownBy(() => define({}, undefined)), { name: 'TypeError', message: '[stats] appCtx is required' })
    check('default export is the named factory', mod.default === define, true)
    check('default level is 1', s.getLevel(1), 1)
    check('default stats at level 1', s.getStats(1), { level: 1, xp: 0, health: 100, mana: 50, damage: 10, defense: 5, speed: 1 })
    check('fresh snapshot is empty', define({}, makeCtx()).snapshot(), {})
    check('_xpForLevel(0) is 0', s._xpForLevel(0), 0)
    check('_xpForLevel(1) is 0', s._xpForLevel(1), 0)
    check('_xpForLevel(2) is 100', s._xpForLevel(2), 100)
    check('_xpForLevel(5) is 400', s._xpForLevel(5), 400)
    check('_levelFromXP(0) is 1', s._levelFromXP(0), 1)
    check('_levelFromXP(99) is 1', s._levelFromXP(99), 1)
    check('_levelFromXP(100) is 2', s._levelFromXP(100), 2)
    check('_levelFromXP(199) is 2', s._levelFromXP(199), 2)
    check('_levelFromXP(200) is 3', s._levelFromXP(200), 3)
    check('_levelFromXP(4899) is 49', s._levelFromXP(4899), 49)
    check('_levelFromXP(4900) is 50', s._levelFromXP(4900), 50)
    check('_levelFromXP(1e9) is capped at 50', s._levelFromXP(1e9), 50)
    for (const bad of [0, -5, NaN, Infinity, '5', null]) {
      check(`addXP rejects ${String(bad)}`, s.addXP(2, bad), false)
    }
    check('rejected addXP leaves level 1', s.getLevel(2), 1)
    check('rejected addXP sends nothing', ctx.sent.length, 0)
    check('addXP(200) is accepted', s.addXP(2, 200), true)
    check('level after 200 xp is 3', s.getLevel(2), 3)
    check('stats scale with level', s.getStats(2), { level: 3, xp: 200, health: 120, mana: 60, damage: 11, defense: 5.5, speed: 1 })
    check('addXP pushes one stats message', ctx.sent[ctx.sent.length - 1], { pid: 2, msg: { type: 'stats', level: 3, xp: 200, nextLevelXP: 300, health: 120, mana: 60, damage: 11, defense: 5.5, speed: 1, equipment: {}, bonuses: {} } })
    check('applyBonus accepts a known stat', s.applyBonus(2, 'health', 25), true)
    check('bonus adds to the scaled stat', s.getStats(2).health, 145)
    check('negative bonus is accepted', s.applyBonus(2, 'health', -5), true)
    check('bonuses accumulate', s.getBonuses(2), { health: 20 })
    check('health reflects the net bonus', s.getStats(2).health, 140)
    check('applyBonus rejects zero', s.applyBonus(2, 'health', 0), false)
    check('applyBonus rejects an unknown stat', s.applyBonus(2, 'luck', 5), false)
    check('applyBonus rejects an inherited property name', s.applyBonus(2, 'toString', 5), false)
    check('applyBonus rejects NaN', s.applyBonus(2, 'mana', NaN), false)
    check('applyBonus rejects a string amount', s.applyBonus(2, 'mana', '5'), false)
    check('rejected applyBonus leaves bonuses unchanged', s.getBonuses(2), { health: 20 })
    const before = ctx.sent.length
    s.push(2)
    check('push sends exactly one message', ctx.sent.length - before, 1)
    check('push targets the player', ctx.sent[ctx.sent.length - 1].pid, 2)
  })

  scenario('level-up callbacks and client pushes', () => {
    const levelUps = []
    const ctx = makeCtx()
    const s = define({ onLevelUp: (appCtx, arg) => levelUps.push({ sameCtx: appCtx === ctx, arg }) }, ctx)
    check('addXP(150) is accepted', s.addXP(7, 150), true)
    check('level-up callback fires once', levelUps.length, 1)
    check('callback receives the app context first', levelUps[0]?.sameCtx, true)
    check('callback payload carries the string id and new level', levelUps[0]?.arg, { playerId: '7', level: 2, stats: { level: 2, xp: 150, health: 110, mana: 55, damage: 10.5, defense: 5.25, speed: 1 } })
    check('addXP(10) inside the same level is accepted', s.addXP(7, 10), true)
    check('no callback without a level change', levelUps.length, 1)
    check('xp accumulates', s.getStats(7).xp, 160)
    check('client push carries nextLevelXP', ctx.sent[ctx.sent.length - 1], { pid: 7, msg: { type: 'stats', level: 2, xp: 160, nextLevelXP: 200, health: 110, mana: 55, damage: 10.5, defense: 5.25, speed: 1, equipment: {}, bonuses: {} } })
    check('addXP(450) is accepted', s.addXP(12, 450), true)
    check('one addXP crossing several levels fires once', levelUps.length, 2)
    check('that single callback carries the final level', levelUps[1]?.arg?.level, 5)
  })

  scenario('a throwing onLevelUp is contained and reported', () => {
    const ctx = makeCtx()
    const s = define({ onLevelUp() { throw new Error('boom') } }, ctx)
    check('addXP is still accepted', s.addXP(3, 100), true)
    check('the level still advances', s.getLevel(3), 2)
    check('the throw is reported through debug.warn', ctx.warns, ['[stats] onLevelUp threw: boom'])
    check('the client is still pushed', ctx.sent.length, 1)
  })

  scenario('maxLevel caps level and xp', () => {
    const s = define({}, makeCtx())
    check('addXP(1e9) is accepted', s.addXP(9, 1e9), true)
    check('level is capped at 50', s.getLevel(9), 50)
    check('xp is clamped to the cap threshold and stats follow', s.getStats(9), { level: 50, xp: 5000, health: 590, mana: 295, damage: 34.5, defense: 17.25, speed: 1 })
  })

  scenario('spec overrides and invalid fallbacks', () => {
    const ctx = makeCtx()
    const s = define({ startLevel: 5, startXP: 1000, xpPerLevel: 50, maxLevel: 10, channel: 'loot', baseStats: { strength: 7 }, statScaling: { strength: 2 } }, ctx)
    check('a startXP above the level curve lifts the level past startLevel', s.getLevel(1), 10)
    check('custom baseStats replace the defaults', s.getStats(1), { level: 10, xp: 500, strength: 25 })
    check('xpPerLevel override drives _xpForLevel', s._xpForLevel(3), 100)
    check('maxLevel override caps _levelFromXP', s._levelFromXP(1e6), 10)
    check('applyBonus rejects a stat outside custom baseStats', s.applyBonus(1, 'health', 5), false)
    check('applyBonus accepts a custom stat', s.applyBonus(1, 'strength', 3), true)
    check('channel override names the push type', ctx.sent[ctx.sent.length - 1].msg.type, 'loot')
    const fallbackCtx = makeCtx()
    const f = define({ startLevel: 0, startXP: -1, xpPerLevel: 0, maxLevel: 'x', channel: '' }, fallbackCtx)
    check('invalid numeric spec values fall back to defaults', { level: f.getLevel(1), xp: f.getStats(1).xp, perLevel: f._xpForLevel(2), maxLevel: f._levelFromXP(1e9) }, { level: 1, xp: 0, perLevel: 100, maxLevel: 50 })
    f.push(1)
    check('an empty channel falls back to stats', fallbackCtx.sent[0].msg.type, 'stats')
  })

  scenario('equipment, loadouts and loadout swaps', () => {
    const swaps = []
    const ctx = makeCtx()
    const s = define({ equipment: equipmentSpec, onLoadoutSwap: (appCtx, arg) => swaps.push(arg) }, ctx)
    check('unknown id is rejected', s.equipItem(1, 'missing'), false)
    check('id from a non-array slot is rejected', s.equipItem(1, 'ring-not-array'), false)
    check('known id is accepted', s.equipItem(1, 'sword'), true)
    check('equipped item is reported with its bonuses', s.getEquipment(1), { weapon: { id: 'sword', name: 'Sword', bonuses: { damage: 5 } } })
    check('equipment bonus adds to the stat', s.getStats(1).damage, 15)
    check('armor is accepted', s.equipItem(1, 'plate'), true)
    check('armor adds defense and health', s.getStats(1), { level: 1, xp: 0, health: 120, mana: 50, damage: 15, defense: 8, speed: 1 })
    check('relic is accepted', s.equipItem(1, 'relic'), true)
    check('bonus on a stat outside baseStats is added', s.getStats(1).crit, 4)
    check('charm is accepted', s.equipItem(1, 'charm'), true)
    check('item without bonuses reports an empty bonuses map', s.getEquipment(1).charm, { id: 'charm', name: 'Charm', bonuses: {} })
    check('axe replaces the sword in the weapon slot', s.equipItem(1, 'axe'), true)
    check('the replaced item bonus is removed', s.getStats(1).damage, 18)
    check('getLoadout maps slot to id', s.getLoadout(1), { weapon: 'axe', armor: 'plate', relic: 'relic', charm: 'charm' })
    check('saveLoadout stores the current slots', s.saveLoadout(1, 'raid'), true)
    check('saveLoadout rejects a blank name', s.saveLoadout(1, '   '), false)
    check('saveLoadout rejects a non-string name', s.saveLoadout(1, 42), false)
    check('getLoadouts reports the saved set', s.getLoadouts(1), { raid: { weapon: 'axe', armor: 'plate', relic: 'relic', charm: 'charm' } })
    const copy = s.getLoadouts(1)
    copy.raid.weapon = 'sword'
    check('getLoadouts returns copies', s.getLoadouts(1).raid.weapon, 'axe')
    check('unequipSlot reports a filled slot', s.unequipSlot(1, 'charm'), true)
    check('unequipSlot reports an empty slot', s.unequipSlot(1, 'charm'), false)
    s.unequipSlot(1, 'weapon')
    s.unequipSlot(1, 'armor')
    s.unequipSlot(1, 'relic')
    check('cleared equipment is empty', s.getLoadout(1), {})
    check('loadLoadout restores a saved set', s.loadLoadout(1, 'raid'), true)
    check('restored slots match the saved loadout', s.getLoadout(1), { weapon: 'axe', armor: 'plate', relic: 'relic', charm: 'charm' })
    check('restored stats match the saved loadout', s.getStats(1).damage, 18)
    check('onLoadoutSwap receives the loadout', swaps, [{ playerId: '1', loadout: { weapon: 'axe', armor: 'plate', relic: 'relic', charm: 'charm' } }])
    check('loadLoadout rejects a missing name', s.loadLoadout(1, 'nope'), false)
  })

  scenario('snapshot and restore round trip', () => {
    const s = define({ equipment: equipmentSpec }, makeCtx())
    s.addXP(4, 350)
    s.applyBonus(4, 'defense', 2)
    s.equipItem(4, 'sword')
    s.equipItem(4, 'plate')
    s.saveLoadout(4, 'tank')
    const snap = s.snapshot()
    check('snapshot keys players by string id', Object.keys(snap), ['4'])
    check('snapshot holds the player state', snap['4'], { level: 4, xp: 350, equipment: { weapon: 'sword', armor: 'plate' }, bonuses: { defense: 2 }, loadouts: { tank: { weapon: 'sword', armor: 'plate' } } })
    const restored = define({ equipment: equipmentSpec }, makeCtx())
    restored.restore(JSON.parse(JSON.stringify(snap)))
    check('restore reproduces level', restored.getLevel(4), 4)
    check('restore reproduces stats', restored.getStats(4), s.getStats(4))
    check('restore reproduces equipment', restored.getEquipment(4), s.getEquipment(4))
    check('restore reproduces loadouts', restored.getLoadouts(4), s.getLoadouts(4))
    check('restore reproduces bonuses', restored.getBonuses(4), { defense: 2 })
    restored.restore(null)
    restored.restore('junk')
    check('restore ignores non-object input', restored.getLevel(4), 4)
    restored.restore({
      9: {
        level: 999,
        xp: -50,
        equipment: { weapon: 'sword', bogus: 'nope' },
        bonuses: { health: 5, luck: 3, mana: 'x', damage: Infinity },
        loadouts: { ok: { weapon: 'sword', armor: 'ghost' }, empty: { armor: 'ghost' }, bad: 'str' },
      },
      8: { level: 0, xp: 0 },
    })
    check('restore derives level from clamped xp, not declared level', restored.getLevel(9), 1)
    check('restore clamps negative xp to zero', restored.getStats(9).xp, 0)
    check('restore keeps only known equipment', restored.getEquipment(9), { weapon: { id: 'sword', name: 'Sword', bonuses: { damage: 5 } } })
    check('restore keeps only known numeric bonuses', restored.getBonuses(9), { health: 5 })
    check('restore keeps only loadouts with known entries', restored.getLoadouts(9), { ok: { weapon: 'sword' } })
    check('restore defaults a zero level to the start level', restored.getLevel(8), 1)
    check('restore replaces previous players', restored.getLevel(4), 1)
  })

  scenario('metamorphic relations on the (level, xp) pair', () => {
    const specs = [
      {},
      { startLevel: 5, startXP: 0 },
      { startXP: 1000 },
      { startLevel: 5, startXP: 1000, xpPerLevel: 50, maxLevel: 10 },
    ]
    const pair = (s, pid) => [s.getLevel(pid), s.getStats(pid).xp]

    check('a startLevel head start keeps its level when startXP does not outrank it', pair(define({ startLevel: 5, startXP: 0 }, makeCtx()), 'p'), [5, 400])

    const seeded = define({ startXP: 1000 }, makeCtx())
    const granted = define({}, makeCtx())
    granted.addXP('p', 1000)
    check('a startXP head start equals the same xp granted by addXP', pair(seeded, 'p'), pair(granted, 'p'))

    const one = define({}, makeCtx())
    one.addXP('p', 250)
    const split = define({}, makeCtx())
    for (const part of [100, 150]) split.addXP('p', part)
    check('addXP(250) equals addXP(100) then addXP(150)', pair(split, 'p'), pair(one, 'p'))

    const capped = define({}, makeCtx())
    capped.addXP('p', 1e9)
    const many = define({}, makeCtx())
    for (let i = 0; i < 200; i++) many.addXP('p', 5e6)
    check('addXP reaching the cap in one call equals 200 calls', pair(many, 'p'), pair(capped, 'p'))

    for (const spec of specs) {
      const label = JSON.stringify(spec)
      const created = define(spec, makeCtx())
      const startPair = pair(created, 'p')
      const snap = JSON.parse(JSON.stringify(created.snapshot()))

      check(`created level is max(1, _levelFromXP(xp)) ${label}`, startPair[0], Math.max(1, created._levelFromXP(startPair[1])))

      const reloaded = define(spec, makeCtx())
      reloaded.restore(snap)
      check(`snapshot then restore reproduces the created pair ${label}`, pair(reloaded, 'p'), startPair)

      const stepped = define(spec, makeCtx())
      stepped.addXP('p', 1)
      const afterPair = pair(stepped, 'p')
      check(`addXP(1) never lowers xp ${label}`, afterPair[1] >= startPair[1], true)
      check(`addXP(1) never lowers level ${label}`, afterPair[0] >= startPair[0], true)
      check(`level stays at the law after addXP ${label}`, afterPair[0], Math.max(1, stepped._levelFromXP(afterPair[1])))

      const restoreFirst = define(spec, makeCtx())
      restoreFirst.restore(snap)
      restoreFirst.addXP('p', 250)
      const addFirst = define(spec, makeCtx())
      addFirst.addXP('p', 250)
      addFirst.restore(JSON.parse(JSON.stringify(addFirst.snapshot())))
      check(`restore then addXP equals addXP then restore ${label}`, pair(addFirst, 'p'), pair(restoreFirst, 'p'))

      const restoredSplit = define(spec, makeCtx())
      restoredSplit.restore(snap)
      restoredSplit.addXP('p', 100)
      restoredSplit.addXP('p', 150)
      check(`addXP after restore is additive ${label}`, pair(restoredSplit, 'p'), pair(restoreFirst, 'p'))
    }

    const dropped = define({}, makeCtx())
    dropped.addXP('p', 350)
    const kept = dropped.snapshot()
    dropped.restore(kept)
    check('restore of a full snapshot keeps every player', Object.keys(dropped.snapshot()), ['p'])
  })
}

const outBlocked = outPath !== null && existsSync(outPath)
if (outBlocked) record(false, `--out is create-only and the path already exists: ${outPath}`)

const total = passed + failed
const exitCode = failed === 0 ? 0 : 1
const resultLine = exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'
const text = [
  'witness: StatsSystem-witness',
  `variant: ${variant}`,
  `module: ${modulePath}`,
  `ts: ${startedAt}`,
  ...lines,
  `checks: ${passed} passed, ${failed} failed, ${total} total`,
  resultLine,
].join('\n') + '\n'

process.stdout.write(text)

let sha256 = '-'
let outRel = '-'
if (outPath !== null && !outBlocked) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, text, { encoding: 'utf8', flag: 'wx' })
  sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  outRel = relative(repoRoot, outPath).split('\\').join('/')
}

if (logPath !== null) {
  const logLine = [
    startedAt,
    'witness=scripts/StatsSystem-witness.mjs',
    `exit=${exitCode}`,
    resultLine,
    `checks=${passed}/${total}`,
    `variant=${variant}`,
    `module=${modulePath.split('\\').join('/')}`,
    `sha256=${sha256}`,
    `out=${outRel}`,
  ].join(' ')
  appendFileSync(logPath, logLine + '\n')
}

process.exitCode = exitCode
