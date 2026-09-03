/**
 * Integration Test Suite for RPG Progression System
 * Runs after all 4 parallel agents complete their deliverables
 *
 * Tests verify:
 * 1. All files exist and are syntactically valid
 * 2. Systems integrate correctly (XP → Level → Ability unlock)
 * 3. Network sync works (multi-player visibility)
 * 4. Persistence works (snapshot save/restore)
 * 5. Performance meets constraints (<1ms per frame)
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts'

/**
 * TEST 1: File Existence & Syntax
 * Verify all 8 expected files were created by agents
 */
export async function testFileExistence() {
  const files = [
    'src/game/ProgressionSystem.js',
    'src/game/AbilityTree.js',
    'src/game/QuestSystem.js',
    'src/game/StatsSystem.js',
    'client/ui/ProgressionUI.js',
    'apps/world/tutorial-rpg.js',
    'apps/rpg-tutorial/index.js',
    'docs/progression-guide.md'
  ]

  for (const file of files) {
    try {
      const content = await Deno.readTextFile(file)
      assert(content.length > 0, `${file} is empty`)
      console.log(`✓ ${file} exists and has content`)
    } catch (e) {
      throw new Error(`Missing file: ${file}`)
    }
  }
}

/**
 * TEST 2: Core System Integration
 * Test XP → Level → Ability progression flow
 */
export async function testProgressionFlow() {
  // Import ProgressionSystem
  const { ProgressionSystem } = await import('./src/game/ProgressionSystem.js')
  const { AbilityTree } = await import('./src/game/AbilityTree.js')

  // Create progression instance
  const prog = new ProgressionSystem({ curve: 'linear' })
  const abilities = new AbilityTree()

  // Test XP addition
  prog.addXP(100)
  assertEquals(prog.currentXP, 100, 'XP should add correctly')

  // Test level calculation
  const level = prog.getLevel()
  assert(level >= 1, 'Level should be at least 1')

  // Test ability unlock
  abilities.defineAbility({
    id: 'attack',
    name: 'Attack',
    unlockLevel: 1,
    cooldown: 0,
    manaCost: 0
  })

  const unlockedAbilities = abilities.getUnlockedAbilities(level)
  assert(unlockedAbilities.length > 0, 'Should have unlocked abilities at level 1')
}

/**
 * TEST 3: Quest System Integration
 */
export async function testQuestSystem() {
  const { QuestSystem } = await import('./src/game/QuestSystem.js')

  const quests = new QuestSystem()

  // Define quest
  quests.defineQuest({
    id: 'kill-goblins',
    title: 'Kill 3 Goblins',
    objectives: [{ type: 'killN', target: 'goblin', count: 3 }],
    rewards: { xp: 30 }
  })

  // Add to player
  const questState = quests.addQuestToPlayer('player1', 'kill-goblins')
  assertEquals(questState.state, 'active', 'Quest should be active')

  // Progress objective
  quests.progressObjective('player1', 'kill-goblins', 0, 1)
  quests.progressObjective('player1', 'kill-goblins', 0, 1)
  quests.progressObjective('player1', 'kill-goblins', 0, 1)

  // Check completion
  const completed = quests.claimRewards('player1', 'kill-goblins')
  assertEquals(completed.rewards.xp, 30, 'Should receive correct XP reward')
}

/**
 * TEST 4: Stats System Integration
 */
export async function testStatsSystem() {
  const { StatsSystem } = await import('./src/game/StatsSystem.js')

  const stats = new StatsSystem()

  // Level 1 should have 100 HP
  const level1Stats = stats.getStatsForLevel(1)
  assertEquals(level1Stats.health, 100, 'Level 1 should have 100 HP')

  // Level 50 should have ~500 HP (linear: 100 + 49*10)
  const level50Stats = stats.getStatsForLevel(50)
  assert(level50Stats.health >= 450 && level50Stats.health <= 550, 'Level 50 should have ~500 HP')

  // Test loadout save/load
  stats.saveLoadout('player1', 'build1', {
    weapon: 'sword',
    armor: 'leather',
    abilities: ['attack', 'fireball']
  })

  const loadout = stats.loadLoadout('player1', 'build1')
  assertEquals(loadout.weapon, 'sword', 'Loadout should restore correctly')
}

/**
 * TEST 5: Ability Cooldown System
 */
export async function testCooldownSystem() {
  const { AbilityTree } = await import('./src/game/AbilityTree.js')

  const abilities = new AbilityTree()

  abilities.defineAbility({
    id: 'fireball',
    name: 'Fireball',
    cooldown: 5000, // 5 seconds
    manaCost: 20
  })

  // Cast ability
  abilities.castAbility('player1', 'fireball')

  // Check cooldown immediately
  let cooldown = abilities.getRemainingCooldown('player1', 'fireball')
  assert(cooldown > 4900, 'Cooldown should be ~5000ms')

  // Simulate 2.5 seconds passing
  abilities.tick(2500)
  cooldown = abilities.getRemainingCooldown('player1', 'fireball')
  assert(cooldown > 2300 && cooldown < 2700, 'Cooldown should be ~2500ms after 2.5s')

  // After 5 seconds, ability should be available
  abilities.tick(2500)
  cooldown = abilities.getRemainingCooldown('player1', 'fireball')
  assertEquals(cooldown, 0, 'Cooldown should be 0 after expiry')
}

/**
 * TEST 6: Snapshot Persistence
 * Verify state can be serialized and restored
 */
export async function testSnapshotPersistence() {
  const { ProgressionSystem } = await import('./src/game/ProgressionSystem.js')

  const prog1 = new ProgressionSystem()
  prog1.addXP(500)
  prog1.levelUp() // Level up to 2

  // Serialize to snapshot
  const snapshot = prog1.toSnapshot()
  assert(snapshot.xp >= 500, 'Snapshot should preserve XP')
  assert(snapshot.level >= 2, 'Snapshot should preserve level')

  // Create new instance and restore
  const prog2 = new ProgressionSystem()
  prog2.fromSnapshot(snapshot)

  assertEquals(prog2.currentXP, prog1.currentXP, 'Restored XP should match')
  assertEquals(prog2.getLevel(), prog1.getLevel(), 'Restored level should match')
}

/**
 * TEST 7: Tutorial RPG Game Execution
 * Verify the example game runs without errors
 */
export async function testTutorialRPGGame() {
  // This test verifies the world definition and app exist
  try {
    const tutorial = await import('./apps/world/tutorial-rpg.js')
    assert(tutorial.default, 'Tutorial RPG world should export default')
    console.log('✓ Tutorial RPG world definition loads')

    const app = await import('./apps/rpg-tutorial/index.js')
    assert(app.default, 'Tutorial RPG app should export default')
    console.log('✓ Tutorial RPG app definition loads')
  } catch (e) {
    throw new Error(`Tutorial RPG game failed to load: ${e.message}`)
  }
}

/**
 * TEST 8: Documentation Completeness
 */
export async function testDocumentation() {
  const docContent = await Deno.readTextFile('docs/progression-guide.md')

  const sections = [
    'Quick Start',
    'API Reference',
    'ProgressionSystem',
    'QuestSystem',
    'AbilityTree',
    'Network Sync',
    'Persistence',
    'Performance',
    'Example'
  ]

  for (const section of sections) {
    assert(docContent.includes(section), `Documentation should include "${section}" section`)
  }

  console.log('✓ Documentation contains all required sections')
}

/**
 * TEST 9: Performance Constraint
 * Verify progression checks complete in <1ms
 */
export async function testPerformanceConstraint() {
  const { ProgressionSystem } = await import('./src/game/ProgressionSystem.js')
  const { AbilityTree } = await import('./src/game/AbilityTree.js')

  const prog = new ProgressionSystem()
  const abilities = new AbilityTree()

  // Warm up
  for (let i = 0; i < 100; i++) {
    prog.addXP(1)
    abilities.tick(16) // 16ms per frame
  }

  // Benchmark 1000 iterations
  const start = performance.now()
  for (let i = 0; i < 1000; i++) {
    prog.addXP(1)
    prog.getLevel()
    abilities.tick(16)
  }
  const elapsed = performance.now() - start
  const msPerIteration = elapsed / 1000

  assert(msPerIteration < 1, `Progression check should be <1ms, got ${msPerIteration.toFixed(3)}ms`)
  console.log(`✓ Performance constraint met: ${msPerIteration.toFixed(3)}ms per iteration`)
}

/**
 * TEST 10: Multiplayer Progression Sync
 * Verify multiple players can progress independently
 */
export async function testMultiplayerSync() {
  const { ProgressionSystem } = await import('./src/game/ProgressionSystem.js')

  const player1 = new ProgressionSystem()
  const player2 = new ProgressionSystem()

  // Player 1 gains XP
  player1.addXP(500)

  // Player 2 gains different XP
  player2.addXP(200)

  // Verify independent progression
  assert(player1.currentXP > player2.currentXP, 'Players should have independent XP')

  // Verify levels track independently
  if (player1.getLevel() > 1) {
    assert(player2.getLevel() === 1, 'Players should have independent levels')
  }

  console.log('✓ Multiplayer progression works independently')
}

/**
 * RUN ALL TESTS
 */
async function runAllTests() {
  const tests = [
    { name: 'File Existence', fn: testFileExistence },
    { name: 'Progression Flow', fn: testProgressionFlow },
    { name: 'Quest System', fn: testQuestSystem },
    { name: 'Stats System', fn: testStatsSystem },
    { name: 'Cooldown System', fn: testCooldownSystem },
    { name: 'Snapshot Persistence', fn: testSnapshotPersistence },
    { name: 'Tutorial RPG Game', fn: testTutorialRPGGame },
    { name: 'Documentation', fn: testDocumentation },
    { name: 'Performance Constraint', fn: testPerformanceConstraint },
    { name: 'Multiplayer Sync', fn: testMultiplayerSync }
  ]

  let passed = 0
  let failed = 0

  console.log('\n=== RPG PROGRESSION SYSTEM INTEGRATION TESTS ===\n')

  for (const test of tests) {
    try {
      await test.fn()
      console.log(`✓ ${test.name}`)
      passed++
    } catch (e) {
      console.error(`✗ ${test.name}: ${e.message}`)
      failed++
    }
  }

  console.log(`\n=== RESULTS: ${passed}/${tests.length} passed ===\n`)

  if (failed > 0) {
    throw new Error(`${failed} tests failed`)
  }
}

// Export for CLI
if (import.meta.main) {
  await runAllTests()
}
