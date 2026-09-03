// Minimal reusable debris-piece app: gives a dynamically spawned entity a real dynamic Jolt body
// parameterized entirely from ctx.config, following the exact box-dynamic pattern. Spawned/attached by
// apps/_lib/destructible.js's createDestructible() -- one destructible call can spawn any number of
// these, each an independent physics body, never a hand-rolled per-game debris implementation.
//
// TWO SHAPE SOURCES, selected per-piece via ctx.config:
//   (a) uniform BOX (default, c.fracturedAsset unset) -- hx/hy/hz/mass-parameterized, unchanged from
//       before this row.
//   (b) FRACTURED-GLB CONVEX HULL (destructibles-fractured-glb-shape-wiring) -- c.fracturedAsset is a
//       path to a scripts/fracture-glb.mjs-baked GLB (one child node/mesh per Voronoi cell,
//       extras.EP_fracture_piece={index,centroid,volume,...}) and c.pieceIndex selects WHICH baked
//       piece this entity's body is built from. ent.model is set to fracturedAsset so this reuses the
//       engine's existing per-mesh convex-hull extraction (ctx.physics.addConvexFromModelAsync(meshIndex),
//       AppPhysics.js -- already used by PLACE_MODEL-authored convex colliders, extractMeshFromGLBAsync
//       already reads ONE mesh by index out of a multi-mesh GLB) rather than inventing new GLB-parsing
//       code. The client also gets ent.model=fracturedAsset so a real per-piece mesh renders (see
//       client/EntityLoader.js's meshIndex/nodeFilter handling for a fractured-piece entity) instead of
//       the uniform-box placeholder.
//
// shapeKey ties this body into World.js's existing box/capsule/convex shapeKey pool (addBody/removeBody,
// see World.js:113-136/567-578): a removeBody(id) on a shapeKey'd body PARKS + POOLS it instead of
// destroying the Jolt shape, and the next addBody() with the SAME shapeKey pulls it back out with a cheap
// reposition instead of a fresh BodyCreationSettings+CreateBody+AddBody. Box pieces key on rounded
// half-extents (not e.g. entity id) so every destructible using the SAME debris piece size across MANY
// destruction events -- and across DIFFERENT destructible objects/entities of the same size -- shares one
// pooled set of Jolt bodies, which is the whole point: a repeated-destruction stress test must NOT keep
// allocating new native bodies per event. Rounded to 3 decimals so float-noise in a caller-derived
// half-extent (debrisCount cbrt division in destructible.js) doesn't fragment the pool into near-duplicate
// keys. Fractured pieces key on glbPath+pieceIndex instead (mirroring World.js's addStaticTrimeshAsync
// glbPath+scale cache-key convention, and AppPhysics.js's addConvexFromModel's own ent.model-as-shapeKey
// precedent) -- two DIFFERENT piece indexes of the same fracturedAsset are never geometrically identical
// the way two uniform debris boxes can be, so this pools per-piece-index reuse (repeated destructions of
// the SAME destructible reuse piece N's own body/shape) rather than pretending different pieces share a
// shape bucket the way same-size uniform boxes correctly do.
//
// MASS is folded into the box key too: World.js's pool-hit path (addBody's `if (sk) {...return}` early
// exit) never re-applies opts.mass to a reused body -- BodyInterface has no SetMassProperties binding, so
// mass can only be set at native BodyCreationSettings-construction time, not after. Two destructibles that
// happen to share a debris SIZE but configure a different debrisShape.mass (or a different intact-object
// custom.mass, since pieceMass derives from it) must NOT share a pool bucket, or the second one silently
// inherits the first one's mass forever. Folding mass into the key means a mass mismatch just costs a
// second pool bucket (still correct, still real reuse within each bucket) instead of silent corruption.
// (Fractured pieces don't fold mass into their key -- addConvexBodyAsync's shapeKey caches only the
// SHAPE, not the body, so a mass difference on a shape-cache hit still creates a fresh body with the
// caller's own mass via _addBody's opts.mass, no cross-destructible mass leak is possible there.)
function _shapeKey(hx, hy, hz, mass) {
  const r = v => Math.round(v * 1000) / 1000
  return `destructible-debris:${r(hx)},${r(hy)},${r(hz)}:m${r(mass)}`
}

export default {
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      if (c.fracturedAsset && Number.isInteger(c.pieceIndex)) {
        // Fractured-GLB convex-hull piece. ent.model drives BOTH the client render (a real per-piece
        // mesh, not a box placeholder) and addConvexFromModelAsync's own extractMeshFromGLBAsync read
        // (meshIndex = pieceIndex, one glTF mesh per baked Voronoi cell) -- spawnEntity already wires
        // config.model -> entity.model, nothing new needed there.
        if (!ctx.entity.custom) {
          ctx.entity.custom = { mesh: 'fracturedPiece', color: c.color ?? 0x8b4513, roughness: c.roughness ?? 0.85, fracturedAsset: c.fracturedAsset, pieceIndex: c.pieceIndex }
        }
        ctx.physics.addColliderFromConfig({ type: 'convex', meshIndex: c.pieceIndex, mass: c.mass ?? 1, dynamic: true, shapeKey: `${c.fracturedAsset}#${c.pieceIndex}` })
        return
      }
      const hx = c.hx ?? 0.25, hy = c.hy ?? 0.25, hz = c.hz ?? 0.25
      if (!ctx.entity.custom) {
        ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x8b4513, roughness: c.roughness ?? 0.85, sx: hx * 2, sy: hy * 2, sz: hz * 2 }
      }
      const mass = c.mass ?? 1
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz], mass, dynamic: true, shapeKey: _shapeKey(hx, hy, hz, mass) })
    }
  }
}
