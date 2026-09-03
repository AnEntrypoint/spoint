import {
  createProgressionSystem,
  CURVE_LINEAR,
  CURVE_EXPONENTIAL,
  CURVE_QUADRATIC,
  DEFAULT_CONFIG,
  getStatScaling
} from './ProgressionSystem.js'

import {
  DEFAULT_ABILITIES,
  HOTKEY_MAP,
  createAbilityTree
} from './AbilityTree.js'

const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`) }

async function testProgressionSystem() {
  console.log('Testing ProgressionSystem...')

  const prog = createProgressionSystem({
    curve: CURVE_QUADRATIC,
    baseXpPerLevel: 100,
    curveScalar: 1.5,
    maxLevel: 100,
    xpPerKill: 10
  })

  const playerId = 123

  assert(prog.getProgress(playerId).level === 1, 'Initial level is 1')
  assert(prog.getProgress(playerId).xp === 0, 'Initial XP is 0')
  assert(prog.getProgress(playerId).progressRatio === 0, 'Initial progress ratio is 0')

  prog.addXp(playerId, 50)
  let progress = prog.getProgress(playerId)
  assert(progress.xp === 50, 'XP incremented by 50')
  assert(progress.level === 1, 'Level still 1 before threshold')

  prog.addXp(playerId, 50)
  progress = prog.getProgress(playerId)
  assert(progress.level === 2, 'Level increased to 2 at threshold')

  const events = prog.drainLevelUpEvents(playerId)
  assert(events.length === 1, 'One level-up event fired')
  assert(events[0].level === 2, 'Event shows level 2')

  prog.addXp(playerId, 300)
  progress = prog.getProgress(playerId)
  assert(progress.level === 3, 'Level increased to 3')

  const snapshot = prog.buildSnapshot()
  assert(snapshot.progressions.length === 1, 'Snapshot has 1 progression entry')
  assert(snapshot.progressions[0].level === 3, 'Snapshot shows level 3')

  const prog2 = createProgressionSystem()
  prog2.applySnapshot(snapshot)
  const restored = prog2.getProgress(playerId)
  assert(restored.level === 3, 'Restored progression has level 3')

  prog.tick(0.016)
  progress = prog.getProgress(playerId)
  assert(progress.level === 3, 'Tick does not affect level')

  const thresholdL1 = prog.calculateXpThreshold(1)
  const thresholdL5 = prog.calculateXpThreshold(5)
  const thresholdL10 = prog.calculateXpThreshold(10)
  assert(thresholdL1 === 0, 'Level 1 threshold is 0')
  assert(thresholdL5 > thresholdL1, 'Level 5 threshold > Level 1')
  assert(thresholdL10 > thresholdL5, 'Level 10 threshold > Level 5')

  const linearThreshold = prog.calculateXpThreshold(20, CURVE_LINEAR)
  const expThreshold = prog.calculateXpThreshold(20, CURVE_EXPONENTIAL)
  assert(linearThreshold < expThreshold, 'Linear threshold < exponential at high level')

  console.log('✓ ProgressionSystem tests passed')
}

async function testAbilityTree() {
  console.log('Testing AbilityTree...')

  const abilities = createAbilityTree()
  const playerId = 456

  const unlockedL1 = abilities.getUnlockedAbilities(1)
  assert(unlockedL1.length > 0, 'Abilities unlock at level 1')
  const fireball = unlockedL1.find(a => a.name === 'Fireball')
  assert(fireball, 'Fireball unlocked at level 1')

  const unlockedL5 = abilities.getUnlockedAbilities(5)
  assert(unlockedL5.length > unlockedL1.length, 'More abilities unlock at level 5')

  assert(abilities.canCastAbility(playerId, 1), 'Can cast ability with no cooldown')

  const cast = abilities.castAbility(playerId, 1, 1)
  assert(cast === true, 'Cast ability succeeds')

  const cooldown = abilities.getAbilityCooldown(playerId, 1)
  assert(cooldown > 0, 'Cooldown is active after cast')

  abilities.tick(1.0)
  const newCooldown = abilities.getAbilityCooldown(playerId, 1)
  assert(newCooldown < cooldown, 'Cooldown decreases after tick')

  const ability = abilities.getAbility(1)
  assert(ability.id === 1, 'getAbility returns correct ability')

  const binding = abilities.getHotkeyBinding(1)
  assert(binding !== null, 'Hotkey 1 has default binding')

  const bound = abilities.bindHotkey(2, 2)
  assert(bound === true, 'Hotkey binding succeeds')

  const newBinding = abilities.getHotkeyBinding(2)
  assert(newBinding === 2, 'Hotkey binding persists')

  const snapshot = abilities.buildSnapshot()
  assert(snapshot.hotkeys, 'Snapshot includes hotkeys')
  assert(snapshot.playerStates, 'Snapshot includes player states')

  const abilities2 = createAbilityTree()
  abilities2.applySnapshot(snapshot)
  const restoredBinding = abilities2.getHotkeyBinding(2)
  assert(restoredBinding === 2, 'Hotkey binding restored from snapshot')

  const allAbilities = abilities.getAllAbilities()
  assert(Array.isArray(allAbilities), 'getAllAbilities returns array')
  assert(allAbilities.length > 0, 'getAllAbilities has entries')

  console.log('✓ AbilityTree tests passed')
}

async function testIntegration() {
  console.log('Testing integration...')

  const prog = createProgressionSystem()
  const abilities = createAbilityTree()

  const playerId = 789
  const maxLevel = prog.getConfig().maxLevel

  for (let i = 1; i < 10; i++) {
    prog.addXp(playerId, 1000)
  }

  const finalProgress = prog.getProgress(playerId)
  assert(finalProgress.level >= 5, 'Player reached at least level 5')

  const unlockedAbilities = abilities.getUnlockedAbilities(finalProgress.level)
  assert(unlockedAbilities.length >= 2, 'Player unlocked multiple abilities')

  const ability = unlockedAbilities[0]
  const canCast = abilities.canCastAbility(playerId, ability.id)
  assert(canCast, 'Can cast unlocked ability')

  const info = abilities.getPlayerAbilityInfo(playerId, finalProgress.level)
  assert(info.unlockedAbilities.length > 0, 'Player has unlocked abilities')

  const scaling1 = getStatScaling(1, 100)
  const scaling10 = getStatScaling(10, 100)
  assert(scaling10 > scaling1, 'Stat scaling increases with level')

  console.log('✓ Integration tests passed')
}

async function testPerformance() {
  console.log('Testing performance...')

  const prog = createProgressionSystem()
  const abilities = createAbilityTree()

  const start = performance.now()

  for (let i = 0; i < 100; i++) {
    prog.addXp(i, 10)
    const progress = prog.getProgress(i)
    prog.tick(0.016)
  }

  for (let i = 0; i < 100; i++) {
    abilities.castAbility(i, 1, 5)
    abilities.getAbilityCooldown(i, 1)
    abilities.tick(0.016)
  }

  const elapsed = performance.now() - start
  console.log(`  1000 operations: ${elapsed.toFixed(2)}ms`)
  assert(elapsed < 50, 'Performance acceptable (<50ms for 1000 ops)')

  console.log('✓ Performance tests passed')
}

async function main() {
  try {
    await testProgressionSystem()
    await testAbilityTree()
    await testIntegration()
    await testPerformance()
    console.log('\n✅ All tests passed')
  } catch (e) {
    console.error('\n❌ Test failed:', e.message)
    process.exit(1)
  }
}

main()
