// A minimal starter app -- a single static box entity. Add more apps with:
//   npx spoint create-app --template <simple|physics|interactive|spawner|fsm-game> <name>
// then reference the new app by name in apps/world/main.js's entities list.
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0x3a6df0 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
