export const TUTORIAL_BUS = {
  strike: 'tutorial-rpg.strike',
  hit: 'tutorial-rpg.hit',
  kill: 'tutorial-rpg.kill',
  collect: 'tutorial-rpg.collect',
  talk: 'tutorial-rpg.talk',
  reach: 'tutorial-rpg.reach',
  bossState: 'tutorial-rpg.boss-state',
  bossQuery: 'tutorial-rpg.boss-query',
}

const labelFor = (name, hp, maxHp) => `${name} ${Math.ceil(hp)}/${maxHp}`

export function defineTutorialFoe(ctx, spec) {
  const { kind, name, maxHp, look, halfExtents, mass, reach, wanderSpeed, leashRadius, wanderSeconds } = spec
  const home = [...ctx.entity.position]
  const contributors = new Set()
  let awake = spec.awake !== false

  ctx.entity.custom = { ...look, label: awake ? labelFor(name, maxHp, maxHp) : spec.dormantLabel }
  ctx.physics.addColliderFromConfig({ type: 'box', size: halfExtents, mass, dynamic: true })
  ctx.interactable({ prompt: awake ? `Press E to strike the ${name}` : spec.dormantPrompt, radius: reach })

  const health = ctx.defineHealth({
    max: maxHp,
    onDamage: (c, { hp }) => { ctx.entity.custom.label = labelFor(name, hp, maxHp) },
    onDeath: () => {
      ctx.entity.custom.label = `${name} (slain)`
      ctx.bus.emit(TUTORIAL_BUS.kill, { entityId: ctx.entity.id, enemyType: kind, playerIds: [...contributors] })
    },
  })

  ctx.bus.on(TUTORIAL_BUS.hit, ({ data }) => {
    if (data?.targetId !== ctx.entity.id || !awake || !health.alive) return
    contributors.add(data.playerId)
    health.damage(data.amount, data.playerId)
  })

  ctx.time.every(wanderSeconds, () => {
    if (!awake || !health.alive) return
    const pos = ctx.entity.position
    const dx = home[0] - pos[0], dz = home[2] - pos[2]
    const fromHome = Math.hypot(dx, dz)
    const angle = fromHome > leashRadius ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2
    ctx.physics.setVelocity([Math.cos(angle) * wanderSpeed, ctx.physics.getVelocity()[1], Math.sin(angle) * wanderSpeed])
  })

  return {
    health,
    get awake() { return awake },
    setAwake(next) {
      if (awake === next || !health.alive) return
      awake = next
      ctx.entity.custom.label = awake ? labelFor(name, health.hp, maxHp) : spec.dormantLabel
      ctx.interactable({ prompt: awake ? `Press E to strike the ${name}` : spec.dormantPrompt, radius: reach })
    },
    onInteract(c, player) {
      if (player?.id == null || !awake || !health.alive) return
      ctx.bus.emit(TUTORIAL_BUS.strike, { targetId: ctx.entity.id, playerId: player.id })
    },
  }
}
