// Regression witness for bug-otb-ball-sync-rootcause (see .gm/prd.yml), kept in-repo intentionally.
// Dynamic entity, NO physics body (no ctx.physics.addXCollider call) -- position mutated directly
// every tick by app code with a SMALL per-tick delta (the one-tap-bounce repro shape). Such entities
// are only reliably relevant/synced to clients because of two fixes: AppRuntime.getUnmanagedDynamicIds()
// threading them into the snapshot dynCache, and Stage.syncPositions() re-indexing them into the
// spatial octree every tick (see src/stage/Stage.js). To re-verify: add this app to a world's
// `entities`/`placeableApps` with bodyType:'dynamic', load via ?singleplayer&world=<name>, and sample
// the client mesh position over several seconds -- it must move continuously, not freeze.
export default {
  server: {
    setup(ctx) {
      ctx.entity.bodyType = 'dynamic'
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00, sx: 1, sy: 1, sz: 1 }
      ctx._startY = ctx.entity.position[1]
      ctx._t = 0
    },
    update(ctx, dt) {
      ctx._t += dt
      // slow, small per-tick delta (~0.2 units/sec), matching the originally-reported y:3->-42 drift shape
      ctx.entity.position[1] = ctx._startY - ctx._t * 0.2
    }
  }
}
