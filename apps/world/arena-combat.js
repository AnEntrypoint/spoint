export const description = 'Shooter declared entirely as data: no app code, one engine behaviour'

export default {
  presets: ['tps', 'arena'],
  arena: { size: 24, wallHeight: 2 },
  players: {
    behaviours: {
      combat: {
        config: {
          respawnTime: 1.5,
          health: 100,
          damagePerHit: 20,
          headshotMultiplier: 2.5,
          headshotZone: 0.7,
          hitKnockback: 4,
          shootKnockback: 2,
          magazineSize: 30,
          reloadTime: 2000,
          spawnInvulnMs: 1500
        }
      }
    }
  }
}
