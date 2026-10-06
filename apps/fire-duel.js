const FIRE_SPEC = {
  radius: 63600,
  role: 'authority',
  rewind: true,
  stepTicks: 10,
  seed: 4242,
  leadTicks: 4,
  regrowSteps: 400,
  checksumEverySteps: 2,
  classes: {
    grass: { fuel: 3000, burnRate: 1500, igniteHeat: 90, heatOut: 500, spotChance: 0, spotHeat: 0, smoke: 40, damage: 6 },
    shrub: { fuel: 12000, burnRate: 2000, igniteHeat: 170, heatOut: 800, spotChance: 40, spotHeat: 400, smoke: 90, damage: 10 },
    forest: { fuel: 45000, burnRate: 2500, igniteHeat: 600, heatOut: 1200, spotChance: 120, spotHeat: 700, smoke: 160, damage: 16 },
  },
}

const IGNITE_TICKS = new Set([90, 240, 420, 600, 780, 960])
const HOME_FACE = 2
const _fires = new WeakMap()

function fireOf(ctx) {
  let fire = _fires.get(ctx)
  if (fire === undefined) {
    fire = ctx.defineFire(FIRE_SPEC)
    _fires.set(ctx, fire)
  }
  return fire
}

export const fireDuelServer = {
  setup(ctx) { fireOf(ctx) },
  update(ctx, dt) {
    const fire = fireOf(ctx)
    fire.tick(dt)
    if (!IGNITE_TICKS.has(ctx.time.tick)) return
    const half = fire.world.lattice.cellsPerFace >> 1
    fire.igniteCell(HOME_FACE, half, half + 1, 1)
  },
}

export default { server: fireDuelServer }
