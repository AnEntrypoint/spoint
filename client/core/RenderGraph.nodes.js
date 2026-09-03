// The render-section nodes: today's real pass order (host-near-far publish -> renderPlanet ->
// camera projection apply -> THREE scene render -> occlusion query commit), calling the SAME
// existing functions unchanged -- these nodes change WHO calls terrainBackdrop.renderPlanet /
// renderer.render / the occlusion runQueries, never WHAT they do.
//
// Handles (terrainBackdrop/vegetation/...) are read from ctx each frame, not captured at build
// time: app.js creates several of them asynchronously after the loop starts.
// ctx is PERSISTENT across frames (app.js reuses one object), so ctx.res carries last-frame
// values -- that is what makes shouldRun-skip semantics ("keep last value") and the deliberate
// one-frame near/far lag below work.

import { RenderControls } from './RenderControls.js'

const _authVegFocus = { x: 0, y: 0, z: 0 }
const _authBenderTmp = { x: 0, y: 0, z: 0 }
// GC-pressure audit (gc-pressure-audit-offscreencanvas-frame-pacing): this loop runs every single
// render frame (foliage-lod-sync has no shouldRun throttle) and used to `.push({x,z,distSq})` a fresh
// object literal per nearby player per frame, plus a fresh `{x,y,z}` temp per player per frame for the
// toAuthoritative() input -- with N players in bend range that is 2*N garbage objects/frame, every
// frame, forever. Grass.js's setBenders() (the sole consumer) only ever reads the nearest MAX_BENDERS
// (8) entries and does so synchronously within the same call this array is built for -- nothing holds
// a reference past that call, so a fixed-size pool of reused row objects is safe: no consumer can ever
// observe a stale/aliased entry across frames. Pool sized generously above MAX_BENDERS since the
// pre-sort candidate set (before the nearest-8 cap) can include every player briefly within
// GRASS_BEND_MAX_RADIUS_M, not just the final 8 kept.
const _BENDER_POOL_SIZE = 64
const _benderPool = Array.from({ length: _BENDER_POOL_SIZE }, () => ({ x: 0, z: 0, distSq: 0 }))
const _benderScratch = [] // holds POOLED row references only; .length reset to 0 each frame, never a fresh push target
const _benderAuthTmp = { x: 0, y: 0, z: 0 } // reused toAuthoritative() input arg (was a fresh {x,y,z} literal per player per frame)
const GRASS_BEND_MAX_RADIUS_M = 60 // generous outer bound before per-candidate distance filtering; keeps the scan cheap even with many connected players

export function buildRenderSectionNodes() {
  return [
    // THREE's camera far floor: max of every THREE-drawn subsystem's own configured visibility
    // radius, with margin -- the bound THREE's frustum cull needs, independent of mapspinner's
    // terrain-horizon far plane.
    //
    // MODEL_VISIBILITY_FLOOR_M (live-fixed 2026-08-10): this max previously included ONLY
    // vegetation/rocks/grass renderDistance -- placed-model/entity meshes (buildings, props, other
    // players) have no equivalent per-subsystem distance config, so a world tuned for short-range
    // vegetation (e.g. tps-game.js's renderDistance:640/rockRenderDistance:320, capped here at
    // ~736m with the 1.15 margin) silently far-clipped every model beyond that range through
    // camera.far (see the 'apply-projection' node below, which sets ctx.camera.far straight from
    // this value) -- entirely unrelated to vegetation, but sharing the same floor by construction.
    // User-witnessed live: 'the far plane is too close on the model layer causing them to disappear'.
    // Floored at 2000m (matches tps-game.js's own terrain.treeline:4000 order of magnitude for what
    // a scene at this planet scale expects to keep visible) until a real per-entity max-draw-distance
    // computation replaces this fixed floor.
    {
      id: 'vegetation-render-distance',
      reads: [],
      writes: ['vegetationRenderDistance'],
      run(ctx) {
        const margin = 1.15
        const MODEL_VISIBILITY_FLOOR_M = 2000
        ctx.res.vegetationRenderDistance = Math.max(
          ctx.vegetation ? ctx.vegetation.renderDistance || 0 : 0,
          ctx.rocks ? ctx.rocks.renderDistance || 0 : 0,
          ctx.grass ? ctx.grass.renderDistance || 0 : 0,
          100,
        ) * margin
        ctx.res.vegetationRenderDistance = Math.max(ctx.res.vegetationRenderDistance, MODEL_VISIBILITY_FLOOR_M)
      },
    },

    // Computes THREE's wanted near/far from LAST frame's planet near/far (ctx.res['camera-context']
    // persists across frames; window.__planetNearFar is the frame-1 fallback mirror) and publishes
    // window.__hostNearFar BEFORE renderPlanet -- mapspinner's depth-writeback re-encode reads it
    // synchronously during that call (gl-render.js dwProg). The one-frame lag is deliberate and
    // harmless (altitude/distance-to-center don't meaningfully change frame-to-frame).
    // Rationale for the derive-don't-copy policy: a pure 1:1 sync swings far too much with altitude
    // on this small-radius planet; a pure fixed override loses altitude-awareness and depth
    // precision (near=0.1/far=500 measured z-fighting live). Near tracks mapspinner's own
    // altitude-scaled near (floored 0.5) so the depth-writeback re-encode never diverges from what
    // mapspinner actually rendered with; far floors at the vegetation radius, caps at
    // distance-to-planet-center (absolute geometric ceiling).
    {
      id: 'host-near-far',
      reads: ['vegetationRenderDistance'],
      writes: ['hostNearFar'],
      shouldRun: ctx => !!ctx.terrainBackdrop,
      run(ctx) {
        const vegFar = ctx.res.vegetationRenderDistance || 0
        const camDist = Math.hypot(ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z)
        const planetRadius = (ctx.terrainBackdrop.planet && ctx.terrainBackdrop.planet.radius) || 63600
        const distToCenter = camDist + planetRadius
        // hostNearFar.near becomes BOTH THREE's real camera.near (a real frustum clip plane, see
        // camera-projection-apply below) AND the depth-writeback re-encode's uDstNear (gl-render.js) --
        // the two are ALWAYS the same value by construction (uDstNear mirrors "whichever projection
        // THREE is actually using this frame", per that shader's own header comment), so this single
        // formula only needs to answer "what should THREE's real frustum near plane be", never
        // "match mapspinner's own internal near" -- mapspinner's altitude-scaled near (gl-render.js
        // render()'s near=altAboveTerrain*0.1) is a SEPARATE, independent value already passed as
        // uSrcNear, used only to correctly LINEARIZE mapspinner's own depth values before they're
        // re-projected onto whatever curve uDstNear/camera.near actually describes -- the two curves
        // never needed to match for the re-encode to be correct, only for uDstNear to genuinely equal
        // camera.near (already guaranteed since both come from this same wantNear).
        //
        // A prior fix (commit 0e63b2ab, "TPS overhead-view depth-writeback near-plane clipped
        // models/plants") mirrored mapspinner's altitude-scaled formula here anyway, conflating the
        // two concerns -- that made hostNearFar.near (and therefore the REAL camera.near) scale
        // aggressively with camera height (2.25m near-plane at just 22.5m altitude), frustum-clipping
        // the base of nearby trees/geometry as the camera rose -- live-reported "when raising the cam
        // the trees disappear off the hillside from the bottom up", confirmed live via
        // window.__camera.near reading 1.76 at a real ~15m spectator altitude. Reverted to a small,
        // altitude-independent near plane -- gameplay geometry (trees, rocks, models) is never more
        // than a few hundred metres from the camera in this game, so a fixed conservative floor never
        // needed altitude-awareness in the first place; only mapspinner's OWN internal near (uSrcNear,
        // untouched here, still altitude-scaled) needed it, for its own depth-precision reasons.
        const wantNear = 0.3
        const wantFar = Math.min(Math.max(vegFar, 100), distToCenter)
        ctx.res.hostNearFar = { near: wantNear, far: wantFar }
        if (typeof window !== 'undefined') window.__hostNearFar = ctx.res.hostNearFar
      },
    },

    // mapspinner's renderPlanet(), UNCHANGED internally (still picks among its own VDRS/direct/THC
    // paths) -- a thin host-side wrapper that captures the globals mapspinner publishes into
    // ctx.res ONCE, so later nodes read ctx.res, never window.* (globals stay as debug mirrors).
    {
      id: 'terrain-depth-color',
      reads: ['hostNearFar'],
      writes: ['camera-context', 'terrainDepth', 'terrainColor'],
      targets: { terrainDepth: 'canvas', terrainColor: 'canvas' },
      // 'camera-context' is read inline via ctx.res['camera-context'] below (a same-node self-
      // consume), never through a declared `reads` edge -- a real, intentional debug mirror, not a
      // forgotten consumer.
      debugMirrors: ['camera-context'],
      shouldRun: ctx => !!ctx.terrainBackdrop,
      run(ctx) {
        ctx.terrainBackdrop.renderPlanet(ctx.camera, ctx.now / 1000, ctx.sun, ctx.floatingOrigin ? ctx.floatingOrigin.toAuthoritative : undefined)
        const nf = (typeof window !== 'undefined') ? window.__planetNearFar : null
        const vp = (typeof window !== 'undefined') ? window.__lastVP : null
        const cam = (typeof window !== 'undefined' && window.__lastGLCam) ? window.__lastGLCam : null
        const live = {
          near: nf && nf.near, far: nf && nf.far, fovy: nf && nf.fovy, aspect: nf && nf.aspect,
          viewProjRel: vp, eye: cam && cam.eye, frameId: ctx.frameId,
        }
        ctx.res['camera-context'] = live
        ctx.res.terrainDepth = { near: live.near, far: live.far, target: 'canvas', frameId: ctx.frameId }
        ctx.res.terrainColor = { target: 'canvas' }
      },
    },

    // Applies the near/far computed pre-planet to THREE's camera AFTER renderPlanet (live order:
    // app.js applied at line ~951, post-renderPlanet, pre-scene-render). 'terrainDepth' read is an
    // order-only marker edge.
    {
      id: 'camera-projection-apply',
      reads: ['hostNearFar', 'terrainDepth'],
      writes: ['cameraSynced'],
      shouldRun: ctx => !!ctx.terrainBackdrop,
      run(ctx) {
        const want = ctx.res.hostNearFar
        if (want && (ctx.camera.near !== want.near || ctx.camera.far !== want.far)) {
          ctx.camera.near = want.near; ctx.camera.far = want.far
          ctx.camera.updateProjectionMatrix()
        }
        ctx.res.cameraSynced = true
      },
    },

    // Foliage LOD/visibility update with current frame camera state (after projection apply).
    // Moved from frameGraph to renderGraph to fix one-frame-late camera state feeding vegetation
    // LOD culling. Runs after camera-projection-apply so vegetation sees current frame's far plane.
    // Removed window.__terrain guard: vegetation LOD must update regardless of terrain init status.
    // Terrain init is async and may be delayed; skipping LOD updates while terrain initializes
    // causes stale LOD state and frame-to-frame flicker. Vegetation placement/rendering works fine
    // without terrain (uses fractal height sampler as fallback).
    //
    // webgpu-veg-placement-decouple-from-raf-for-backgrounded-tab: this node only fires while rAF is
    // running (foreground tab) -- ctx.placementScheduler (client/core/PlacementScheduler.js, started
    // unconditionally in app.js) owns a background setInterval calling the SAME vegetation/rocks/
    // grass.update() functions independent of rAF, so a backgrounded tab keeps streaming. The
    // shouldTick(now) call below shares that scheduler's single `_lastTickAtMs` gate so foreground
    // rAF and the background interval never double-tick the same wall-clock instant (whichever
    // reaches it first wins; dt is accounted once). When ctx.placementScheduler is absent (should
    // never happen in production, defensive only) this node runs unconditionally, matching the
    // pre-existing behavior byte-for-byte.
    {
      id: 'foliage-lod-sync',
      reads: ['cameraSynced'],
      writes: [],
      shouldRun: ctx => !!(ctx.vegetation || ctx.rocks || ctx.grass),
      run(ctx) {
        // Wind sway advances every real frame regardless of the placement-decision throttle below
        // (see Vegetation.js/Grass.js's tickWind docs) -- it is a cheap per-material GPU uniform, and
        // gating it on the same ~25Hz placement throttle produced visibly jerky/stepped sway.
        const _windDt = ctx.res.frameDt || 0
        if (ctx.vegetation && typeof ctx.vegetation.tickWind === 'function') { try { ctx.vegetation.tickWind(_windDt) } catch (_) {} }
        if (ctx.grass && typeof ctx.grass.tickWind === 'function') { try { ctx.grass.tickWind(_windDt) } catch (_) {} }
        if (ctx.placementScheduler && !ctx.placementScheduler.shouldTick(ctx.now)) return
        const frameDt = ctx.res.frameDt || 0
        let vegFocus = ctx.res.vegFocus || ctx.camera.position
        const shadowMoved = ctx.res.shadowMoved || false
        // Vegetation/Rocks/Grass place instances by generating REAL authoritative local-frame
        // positions (placementsForChunk -> frame/anchorField, chunk-keyed off the same x/z passed
        // here) and writing them straight into InstancedMesh2 instance transforms -- their own
        // top-level scene root is translated by the floating-origin rebase same as everything else
        // (see FloatingOrigin.js's _translateChildren, which walks ALL of scene.children), so the
        // chunk-key/placement math itself must be fed the AUTHORITATIVE (unshifted) camera/focus
        // position, never the rebased render-space one -- otherwise a freshly streamed-in chunk past
        // a rebase would generate/sample terrain at the wrong (near-zero) planetary location while
        // already-loaded chunks (translated in place, still correct) sit at the real one.
        if (ctx.floatingOrigin) {
          vegFocus = ctx.floatingOrigin.toAuthoritative(vegFocus.position ? { x: vegFocus.position[0], y: vegFocus.position[1], z: vegFocus.position[2] } : vegFocus, _authVegFocus)
        }
        if (ctx.vegetation && typeof ctx.vegetation.update === 'function') {
          try { ctx.vegetation.update(frameDt, ctx.camera, vegFocus, !shadowMoved) } catch (_) {}
        }
        if (ctx.rocks && typeof ctx.rocks.update === 'function') {
          try { ctx.rocks.update(frameDt, ctx.camera, vegFocus) } catch (_) {}
        }
        if (ctx.grass && typeof ctx.grass.update === 'function') {
          // Nearby-player bend buffer: real per-player world positions from ctx.pm.playerMeshes (a
          // Map<id, THREE.Group>, populated for BOTH the local player and every remote player --
          // see client/PlayerManager.js), converted to the SAME authoritative (unshifted) local-frame
          // space as vegFocus above -- Grass.js's vertex shader compares bender XZ against
          // instanceMatrix[3].xz, which is the blade's authoritative placement position (InstancedMesh2's
          // own root is what the floating-origin rebase translates, not the per-instance transforms), so
          // feeding it render-space (rebased) player positions would silently desync after the first
          // rebase. Distance-filtered + sorted nearest-first + capped at Grass.MAX_BENDERS here (not
          // inside Grass.js) so the cheap-to-call-every-frame contract on grass.update's caller side is
          // honored without Grass.js needing to know about ctx.pm at all.
          _benderScratch.length = 0
          if (ctx.pm && ctx.pm.playerMeshes && ctx.pm.playerMeshes.size) {
            const fx = vegFocus.x, fz = vegFocus.z
            let _poolN = 0
            for (const [, mesh] of ctx.pm.playerMeshes) {
              if (!mesh || !mesh.position) continue
              let wx = mesh.position.x, wy = mesh.position.y, wz = mesh.position.z
              if (ctx.floatingOrigin) {
                _benderAuthTmp.x = wx; _benderAuthTmp.y = wy; _benderAuthTmp.z = wz
                const a = ctx.floatingOrigin.toAuthoritative(_benderAuthTmp, _authBenderTmp)
                wx = a.x; wz = a.z
              }
              const ddx = wx - fx, ddz = wz - fz
              const distSq = ddx * ddx + ddz * ddz
              if (distSq > GRASS_BEND_MAX_RADIUS_M * GRASS_BEND_MAX_RADIUS_M) continue
              // Pool exhaustion (more than _BENDER_POOL_SIZE players simultaneously in bend range) is
              // a real-but-extreme case: drop the overflow candidate rather than growing/allocating --
              // the nearest-first sort below means only the closest _BENDER_POOL_SIZE ever matter
              // anyway once MAX_BENDERS(8) truncates further, so a dropped far-tail candidate never
              // changes the final bend set in practice.
              if (_poolN >= _BENDER_POOL_SIZE) continue
              const row = _benderPool[_poolN++]
              row.x = wx; row.z = wz; row.distSq = distSq
              _benderScratch.push(row)
            }
            if (_benderScratch.length > 1) _benderScratch.sort((a, b) => a.distSq - b.distSq)
          }
          try { ctx.grass.update(frameDt, ctx.camera, vegFocus, _benderScratch) } catch (_) {}
        }
      },
    },

    // renderer.render(scene, camera) -- depth-tests against whatever terrain-depth-color left in
    // the canvas depth buffer. autoClear gating matches the pre-graph `if (terrainBackdrop)` shape.
    // required: a frame must draw; disable() refuses.
    //
    // THREE-VDRS BRANCH (true-upscale-decoupled-render-resolution-three-scene): when
    // RenderControls('threeVdrs') is on AND ctx.threeVdrs exists AND the current scale is genuinely
    // below native (window.__threeVdrsScale < 0.999), route through ThreeVdrs.js's low-res-render +
    // EASU/RCAS-upscale + depth-tested composite instead of the direct renderer.render call. See
    // ThreeVdrs.js's module header for why this composite still correctly (a) gets occluded BY
    // terrain and (b) leaves THREE's own depth in the canvas for any later same-frame consumer. The
    // DEFAULT (flag off, or ctx.threeVdrs not installed) path below is BYTE-UNCHANGED.
    {
      id: 'scene-color',
      reads: ['terrainDepth', 'terrainColor', 'cameraSynced'],
      writes: ['sceneDepth', 'sceneColor'],
      targets: { sceneDepth: 'canvas', sceneColor: 'canvas' },
      required: true,
      run(ctx) {
        const hasTerrain = !!ctx.terrainBackdrop
        const scale = (typeof window !== 'undefined') ? +window.__threeVdrsScale || 1.0 : 1.0
        const useVdrs = RenderControls.get('threeVdrs') === true && !!ctx.threeVdrs && scale < 0.999
        if (useVdrs) {
          ctx.threeVdrs.compute(scale)
          if (hasTerrain) ctx.renderer.autoClear = false
          ctx.threeVdrs.composite(hasTerrain)
          if (hasTerrain) ctx.renderer.autoClear = true
        } else {
          if (hasTerrain) ctx.renderer.autoClear = false
          ctx.renderer.render(ctx.scene, ctx.camera)
          if (hasTerrain) ctx.renderer.autoClear = true
        }
        ctx.res.sceneDepth = { target: 'canvas', frameId: ctx.frameId }
        ctx.res.sceneColor = { target: 'canvas' }
      },
    },

    // Issue+resolve fresh occlusion queries against the NOW-FINAL depth; results apply next frame.
    // Preserves the exact modelPool -> terrainBackdrop -> sceneOcclusion order animate() used.
    //
    // cull-shared-query-budget (GPU-time-driven, see client/core/OcclusionQueryBudget.js): each
    // consumer's setMaxQueriesPerFrame/setOcclusionQueryBudget is applied from ctx.occlusionQueryBudget
    // immediately BEFORE that consumer's own query pass (the arbiter's apply() must run before
    // runQueries so the allocation actually takes effect on THIS frame's issue, not next frame's), and
    // each consumer's real candidate count is reported back immediately AFTER via its own getStats()
    // (feeds the arbiter's next-frame proportional split). ctx.occlusionQueryBudget.reportFrameTime()
    // is called once per frame in app.js's animate(), before renderGraph.run -- not here, since it is
    // frame-global, not per-consumer.
    {
      id: 'visibility-commit',
      reads: ['sceneDepth'],
      writes: ['occlusionCommitted'],
      // Intentionally-terminal completion marker (see comment below): no downstream node reads
      // occlusionCommitted, it just stamps that this frame's queries were issued.
      terminal: true,
      // occlusionCommitted is a pure "queries issued this frame" stamp -- no other node reads it;
      // this node's real effect is entirely external (GPU occlusion-query submission whose results
      // land next frame via modelPool/terrainBackdrop/sceneOcclusion's own internal state, not a
      // ctx.res read). See RenderGraph.js's NODE CONTRACT `terminal` doc.
      terminal: true,
      run(ctx) {
        const budget = ctx.occlusionQueryBudget
        if (ctx.modelPool && ctx.modelPool.setOcclusionQueryBudget) {
          budget?.apply('modelPool', n => ctx.modelPool.setOcclusionQueryBudget(n))
        }
        ctx.modelPool.runOcclusionQueries?.()
        if (budget && ctx.modelPool && ctx.modelPool.getStats) {
          try { budget.reportCandidates('modelPool', ctx.modelPool.getStats().candidates) } catch (_) {}
        }
        if (ctx.terrainBackdrop) {
          if (budget && ctx.terrainBackdrop.setOcclusionQueryBudget) budget.apply('terrain', n => ctx.terrainBackdrop.setOcclusionQueryBudget(n))
          ctx.terrainBackdrop.runOcclusionQueries?.()
          if (budget && ctx.terrainBackdrop.getOcclusionStats) {
            try { budget.reportCandidates('terrain', ctx.terrainBackdrop.getOcclusionStats().candidates) } catch (_) {}
          }
        }
        if (budget) budget.apply('scene', n => ctx.sceneOcclusion.setMaxQueriesPerFrame(n))
        ctx.sceneOcclusion.runQueries(ctx.camera)
        if (budget) {
          try { budget.reportCandidates('scene', ctx.sceneOcclusion.getStats().candidates) } catch (_) {}
        }
        ctx.res.occlusionCommitted = ctx.frameId
      },
    },
  ]
}
