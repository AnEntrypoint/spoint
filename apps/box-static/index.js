export default {
  server: {
    editorProps: [
      { key: 'hx', label: 'Width/2', type: 'number', default: 1 },
      { key: 'hy', label: 'Height/2', type: 'number', default: 1 },
      { key: 'hz', label: 'Depth/2', type: 'number', default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#888888' },
      { key: 'roughness', label: 'Roughness', type: 'number', default: 0.9 },
      // Material-authored wetness mask (ssr-material-wetness-mask-authoring): a thin, wide box is the
      // natural puddle/wet-road authoring shape. 0 = dry, 1 = fully wet; consumed client-side by
      // SSR.js via EntityLoader's userData.wetness tag. Key is `_wetness` (underscore-prefixed, NOT
      // `wetness`) to match the convention every other authored engine flag in this codebase already
      // uses (_collider, _interior, PRIMITIVE_EDITOR_PROPS' own _wetness in EditorHandlers.js) -- this
      // app's own editorProps are read here (worldDef.entities[].app:'box-static' spawn path via
      // appRuntime.spawnEntity), NOT the same code as PLACE_APP's synthetic 'box-static' shortcut
      // (EditorHandlers.js's PRIMITIVE map, which never calls this setup() at all -- see that file's
      // own comment). Both paths now use the identical `_wetness` key so an authored value round-trips
      // the same way regardless of which one placed the entity.
      { key: '_wetness', label: 'Wetness', type: 'range', min: 0, max: 1, step: 0.05, default: 0 }
    ],
    setup(ctx) {
      const c = ctx.config
      const hx = c.hx ?? 1, hy = c.hy ?? 1, hz = c.hz ?? 1
      // Pre-existing behavior: custom (and therefore the visible render mesh) was only assigned when
      // an explicit color was authored -- a colorless box-static stayed a physics-only collider with
      // whatever default box the client's own buildEntityMesh fallback draws. That gate must not also
      // silently drop an authored _wetness (found live this session: a world-def box-static entity
      // with only config._wetness set, no color, got custom:{} and its wetness never reached the
      // client) -- so _wetness is applied to ctx.entity.custom independently of the color gate below.
      if (c.color !== undefined) ctx.entity.custom = { mesh: 'box', color: c.color, roughness: c.roughness ?? 0.9, sx: hx*2, sy: hy*2, sz: hz*2 }
      if (c._wetness !== undefined) { if (!ctx.entity.custom) ctx.entity.custom = {}; ctx.entity.custom._wetness = c._wetness }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz] })
    }
  }
}
