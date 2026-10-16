import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const witnessPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(witnessPath), '..')
const defaultModulePath = resolve(repoRoot, 'apps', '_lib', 'progression.js')
const outDir = resolve(repoRoot, '.gm', 'witness-out')
const modulePath = process.argv[2] ? resolve(process.argv[2]) : defaultModulePath
const runLabel = process.env.PROGRESSION_WITNESS_RUN || 'adhoc'
const stamp = new Date().toISOString()

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const messageOf = (error) => String(error && error.message ? error.message : error)

const claims = []
const record = (id, name, expected, got) => {
  claims.push({ id, name, expected, got, pass: JSON.stringify(expected) === JSON.stringify(got) })
}

const drive = (mod) => {
  const obs = { scenarioError: null }
  const hookLevels = []
  const tickLevels = []
  const sent = []
  try {
    const system = mod.defineProgression({
      onLevelUp: (ctx, level) => hookLevels.push(level),
      onLevelUpTick: (ctx, level) => tickLevels.push(level)
    })
    const ctx = { entity: { id: 'p1' }, world: { sendToEntity: (id, message) => sent.push({ id, message }) } }
    system.setup(ctx)
    system.onPlayerJoin('p1')
    const p = ctx.progression
    const progressView = (view) => ({
      level: view.level,
      xp: view.xp,
      totalXp: view.totalXp,
      xpForLevel: view.xpForLevel,
      xpInLevel: view.xpInLevel,
      progressRatio: view.progressRatio
    })

    obs.start = [p.getLevel(), p.getXp(), p.getTotalXp()]
    obs.addBelowThreshold = p.addXp(99)
    obs.afterBelowThreshold = [p.getLevel(), p.getXp()]
    obs.addToLevelTwo = p.addXp(1)
    obs.afterLevelTwo = [p.getLevel(), p.getXp(), p.getTotalXp()]
    obs.addNegative = p.addXp(-5)
    obs.addNaN = p.addXp(NaN)
    obs.totalAfterInvalid = p.getTotalXp()
    obs.addToLevelThree = p.addXp(300)
    obs.progressAtLevelThree = progressView(p.getProgress())
    obs.addPartial = p.addXp(250)
    obs.progressPartial = progressView(p.getProgress())
    obs.addToLevelFour = p.addXp(250)
    obs.levelFourState = [p.getLevel(), p.getXp()]
    system.tick(ctx, 0.016)
    obs.hookLevels = hookLevels.slice()
    obs.tickLevels = tickLevels.slice()
    obs.sentMessages = sent.map((entry) => entry.message)

    obs.unlockedAtLevelFour = p.getUnlockedAbilities().map((ability) => ability.id)
    obs.castFirst = p.castAbility(1).ok
    obs.castFirstAgain = p.castAbility(1).ok
    obs.castLockedSecond = p.castAbility(2).ok
    obs.cooldownAfterCast = p.getAbilityCooldown(1)
    obs.canCastWhileCooling = p.canCastAbility(1).ok
    obs.bindings = [p.bindHotkey(6, 2).ok, p.bindHotkey(6, 99).ok, p.bindHotkey(0, 1).ok, p.bindHotkey(10, 1).ok, p.bindHotkey(7, null).ok]
    obs.statScalingLevelFour = p.getStatScaling(100)
    const network = system.getNetworkState('p1')
    obs.network = [
      network.progression.level,
      network.abilityTree.unlockedAbilities.map((ability) => ability.id),
      network.abilityTree.cooldowns
    ]
    obs.snapshot = JSON.parse(JSON.stringify(system.snapshotGameState({})))

    system.tick(ctx, 1.0)
    obs.cooldownAfterOneTick = p.getAbilityCooldown(1)
    system.tick(ctx, 1.0)
    obs.cooldownAfterTwoTicks = p.getAbilityCooldown(1)
    obs.canCastAfterCooldown = p.canCastAbility(1).ok
    obs.castLockedFifth = p.castAbility(5).ok

    system.onPlayerLeave('p1')
    obs.afterLeave = [p.getLevel(), p.getTotalXp(), p.getAbilityCooldown(1)]

    const restored = mod.defineProgression({})
    restored.restoreGameState(JSON.parse(JSON.stringify(obs.snapshot)))
    const restoredCtx = { entity: { id: 'p1' }, world: { sendToEntity: () => {} } }
    restored.setup(restoredCtx)
    const rp = restoredCtx.progression
    obs.restored = [rp.getLevel(), rp.getTotalXp(), rp.getXp(), rp.getAbilityCooldown(1)]
    const restoredHotkeys = restored.snapshotGameState({}).abilityTree.hotkeys
    obs.restoredHotkeys = [restoredHotkeys['6'], restoredHotkeys['7']]

    const isolated = mod.defineProgression({})
    const isolatedCtx = { entity: { id: 'p2' }, world: { sendToEntity: () => {} } }
    isolated.setup(isolatedCtx)
    isolated.onPlayerJoin('p2')
    isolatedCtx.progression.addXp(900)
    const frozen = isolated.snapshotGameState({})
    const pendingIn = (snapshot) => snapshot.progression.progressions.find((entry) => entry.id === 'p2').levelUpEvents.length
    obs.pendingBeforeLaterLevelUp = pendingIn(frozen)
    isolatedCtx.progression.addXp(700)
    obs.pendingInSnapshotAfterLaterLevelUp = pendingIn(frozen)

    const stranger = mod.defineProgression({})
    const strangerCtx = { entity: { id: 'p9' }, world: { sendToEntity: () => {} } }
    stranger.setup(strangerCtx)
    stranger.onPlayerJoin('p1')
    const abilityStatesIn = (snapshot) => snapshot.abilityTree.playerStates.map((entry) => entry.playerId)
    obs.abilityStatesBefore = abilityStatesIn(stranger.snapshotGameState({}))
    obs.cooldownUnknownVsReady = [strangerCtx.progression.getAbilityCooldown(9999), strangerCtx.progression.getAbilityCooldown(1)]
    obs.abilityStatesAfter = abilityStatesIn(stranger.snapshotGameState({}))

    const networkIdsIn = (snapshot) => snapshot.progression.progressions.map((entry) => entry.id)
    obs.strangerIdsBefore = networkIdsIn(stranger.snapshotGameState({}))
    const strangerNetwork = stranger.getNetworkState('stranger')
    obs.strangerNetwork = [
      strangerNetwork.progression.level,
      strangerNetwork.abilityTree.unlockedAbilities.map((ability) => ability.id),
      strangerNetwork.abilityTree.cooldowns
    ]
    obs.strangerIdsAfter = networkIdsIn(stranger.snapshotGameState({}))

    const echo = mod.defineProgression({})
    const echoState = {}
    obs.emptyRestoreIdentity = echo.restoreGameState(echoState) === echoState
    obs.emptyRestorePayload = JSON.parse(JSON.stringify(echo.restoreGameState({})))
    try {
      echo.restoreGameState(undefined)
      obs.emptyRestoreMissing = null
    } catch (error) {
      obs.emptyRestoreMissing = messageOf(error)
    }
  } catch (error) {
    obs.scenarioError = messageOf(error)
  }
  return obs
}

const evaluate = (mod, obs) => {
  const exported = (read) => {
    try {
      return read()
    } catch (error) {
      return messageOf(error)
    }
  }
  record('C00', 'scenario completes without throwing', null, obs.scenarioError)
  record('C01', 'module exports defineProgression as a function', true, exported(() => typeof mod.defineProgression === 'function'))
  record('C02', 'DEFAULT_ABILITIES exports five abilities', 5, exported(() => mod.DEFAULT_ABILITIES.length))
  record('C03', 'DEFAULT_CONFIG exports quadratic curve and maxLevel 100', ['quadratic', 100], exported(() => [mod.DEFAULT_CONFIG.curve, mod.DEFAULT_CONFIG.maxLevel]))
  record('C04', 'HOTKEY_MAP binds hotkeys 1 through 9', 9, exported(() => Object.keys(mod.HOTKEY_MAP).length))
  record('C05', 'a fresh player starts at level 1 with no xp', [1, 0, 0], obs.start)
  record('C06', 'xp below the level-two threshold reports no level-up', false, obs.addBelowThreshold)
  record('C07', 'xp below the threshold accumulates inside level 1', [1, 99], obs.afterBelowThreshold)
  record('C08', 'reaching 100 total xp levels the player to 2', true, obs.addToLevelTwo)
  record('C09', 'level two carries the leftover xp and the total', [2, 0, 100], obs.afterLevelTwo)
  record('C10', 'negative and NaN xp grants are ignored', [false, false, 100], [obs.addNegative, obs.addNaN, obs.totalAfterInvalid])
  record('C11', 'reaching 400 total xp levels the player to 3', true, obs.addToLevelThree)
  record('C12', 'progress at the level-three threshold is zero into the level', { level: 3, xp: 0, totalXp: 400, xpForLevel: 500, xpInLevel: 0, progressRatio: 0 }, obs.progressAtLevelThree)
  record('C13', 'partial xp below the next threshold gives a half progress ratio', [false, { level: 3, xp: 250, totalXp: 650, xpForLevel: 500, xpInLevel: 250, progressRatio: 0.5 }], [obs.addPartial, obs.progressPartial])
  record('C14', 'reaching 900 total xp levels the player to 4 with no xp left', [true, 4, 0], [obs.addToLevelFour, ...(obs.levelFourState || [])])
  record('C15', 'the level-up hook fires once per leveling call, in order', [2, 3, 4], obs.hookLevels)
  record('C16', 'each level-up sends a progression levelUp message to the entity', [
    { type: 'progression', event: 'levelUp', level: 2, xp: 0, totalXp: 100 },
    { type: 'progression', event: 'levelUp', level: 3, xp: 0, totalXp: 400 },
    { type: 'progression', event: 'levelUp', level: 4, xp: 0, totalXp: 900 }
  ], obs.sentMessages)
  record('C17', 'tick drains pending level-up events to the tick hook', [2, 3, 4], obs.tickLevels)
  record('C18', 'only abilities unlocked at the current level are listed', [1], obs.unlockedAtLevelFour)
  record('C19', 'castAbility casts once, refuses while cooling down, and refuses a locked ability', [true, false, false], [obs.castFirst, obs.castFirstAgain, obs.castLockedSecond])
  record('C20', 'a cast starts the cooldown and canCastAbility reports it cooling', [2, false], [obs.cooldownAfterCast, obs.canCastWhileCooling])
  record('C21', 'hotkey binding accepts known ids and null, rejects unknown ids and out-of-range hotkeys', [true, false, false, false, true], obs.bindings)
  record('C22', 'getStatScaling applies the quadratic curve at level 4', 130, obs.statScalingLevelFour)
  record('C23', 'getNetworkState reports level, unlocked ability ids and active cooldowns', [4, [1], [{ abilityId: 1, remaining: 2 }]], obs.network)
  record('C24', 'cooldowns count down with tick and the ability is castable again at zero', [1, 0, true], [obs.cooldownAfterOneTick, obs.cooldownAfterTwoTicks, obs.canCastAfterCooldown])
  record('C25', 'castAbility refuses an ability whose unlock level is above the player level', false, obs.castLockedFifth)
  record('C26', 'onPlayerLeave clears level, xp and cooldowns', [1, 0, 0], obs.afterLeave)
  record('C27', 'restoreGameState reinstates level, xp and cooldown from a JSON snapshot', [4, 900, 0, 2], obs.restored)
  record('C28', 'restoreGameState reinstates hotkey bindings from a JSON snapshot', [2, null], obs.restoredHotkeys)
  record('C29', 'isolation probe starts with three pending level-up events', 3, obs.pendingBeforeLaterLevelUp)
  record('C30', 'a snapshot taken earlier does not change when later level-ups occur', 3, obs.pendingInSnapshotAfterLaterLevelUp)
  record('C31', 'getAbilityCooldown answers 0 for an unknown ability and for a ready one', [0, 0], obs.cooldownUnknownVsReady)
  record('C32', 'a cooldown query registers a player the ability tree had never seen', [['p1'], ['p1', 'p9']], [obs.abilityStatesBefore, obs.abilityStatesAfter])
  record('C33', 'getNetworkState answers for a player that never joined and registers it', [['p1'], [1, [1], []], ['p1', 'stranger']], [obs.strangerIdsBefore, obs.strangerNetwork, obs.strangerIdsAfter])
  record('C34', 'restoreGameState echoes an empty state back as success', [true, {}], [obs.emptyRestoreIdentity, obs.emptyRestorePayload])
  record('C35', 'restoreGameState throws on a missing state', "Cannot read properties of undefined (reading 'progression')", obs.emptyRestoreMissing)
}

const main = async () => {
  const body = [
    'progression-witness ts=' + stamp + ' run=' + runLabel,
    'witness_sha256=' + sha256(readFileSync(witnessPath)),
    'module=' + modulePath
  ]
  let resultLine
  if (!existsSync(modulePath)) {
    resultLine = 'RESULT: FAIL -- module path does not exist: ' + modulePath
  } else {
    body.push('module_sha256=' + sha256(readFileSync(modulePath)))
    let mod = null
    let importFailure = null
    try {
      mod = await import(pathToFileURL(modulePath).href)
    } catch (error) {
      importFailure = messageOf(error)
    }
    if (importFailure !== null) {
      resultLine = 'RESULT: FAIL -- module import failed: ' + importFailure
    } else {
      const obs = drive(mod)
      evaluate(mod, obs)
      for (const c of claims) {
        body.push(c.pass
          ? 'CHECK ' + c.id + ' ' + c.name + ': PASS'
          : 'CHECK ' + c.id + ' ' + c.name + ': FAIL expected=' + JSON.stringify(c.expected) + ' got=' + JSON.stringify(c.got))
      }
      const failed = claims.filter((c) => !c.pass).length
      resultLine = failed === 0
        ? 'RESULT: PASS claims=' + claims.length + ' failed=0'
        : 'RESULT: FAIL claims=' + claims.length + ' failed=' + failed
    }
  }
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'progression-witness-' + stamp.replace(/[:.]/g, '-') + '-' + process.pid + '-' + randomBytes(4).toString('hex') + '.txt')
  writeFileSync(outPath, [...body, resultLine].join('\n') + '\n', { flag: 'wx' })
  console.log(body.join('\n'))
  console.log('out=' + outPath)
  console.log(resultLine)
  process.exitCode = resultLine.startsWith('RESULT: PASS') ? 0 : 1
}

main().catch((error) => {
  console.log('RESULT: FAIL -- witness error: ' + messageOf(error))
  process.exitCode = 1
})
