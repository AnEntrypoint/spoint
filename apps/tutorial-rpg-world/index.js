// Tutorial RPG World: controller entity managing quests, enemies, and world state

export const server = {
  setup(ctx) {
    ctx.state = {
      ratCount: 0,
      beastDefeated: false,
    }

    // Spawn tutorial enemies
    ctx.world.spawnChild('rat-1', { app: 'tutorial-rat', position: [10, 1, 10] })
    ctx.world.spawnChild('rat-2', { app: 'tutorial-rat', position: [15, 1, 12] })
    ctx.world.spawnChild('rat-3', { app: 'tutorial-rat', position: [12, 1, 8] })
    ctx.world.spawnChild('rat-4', { app: 'tutorial-rat', position: [8, 1, 15] })
    ctx.world.spawnChild('rat-5', { app: 'tutorial-rat', position: [18, 1, 18] })

    // Spawn NPCs
    ctx.world.spawnChild('elder', { app: 'tutorial-npc', position: [0, 1, 0], custom: { npcId: 'elder' } })
    ctx.world.spawnChild('healer', { app: 'tutorial-npc', position: [5, 1, -5], custom: { npcId: 'healer' } })

    // Spawn boss (initially inactive)
    ctx.world.spawnChild('shadow-beast', { app: 'tutorial-boss', position: [100, 10, 100], custom: { active: false } })

    // Spawn herbs
    for (let i = 0; i < 10; i++) {
      const x = 50 + Math.random() * 40 - 20
      const z = 50 + Math.random() * 40 - 20
      ctx.world.spawnChild(`herb-${i}`, { app: 'tutorial-herb', position: [x, 1, z] })
    }

    // Spawn shrine marker
    ctx.world.spawnChild('shrine-marker', { app: 'tutorial-marker', position: [100, 10, 100], custom: { marker: 'shrine' } })
  },

  tick(ctx, dt) {
    // World tick - could handle quest progression here
  },

  onMessage(ctx, msg) {
    if (msg.type === 'ratKilled') {
      ctx.state.ratCount++
      // Broadcast to all players
      ctx.world.sendToEntity('quest-broadcast', { type: 'ratCount', count: ctx.state.ratCount })
    }

    if (msg.type === 'beastDefeated') {
      ctx.state.beastDefeated = true
    }
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialRPGWorld] Client mounted')
  },
}
