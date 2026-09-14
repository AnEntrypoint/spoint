import { RenderControls } from './RenderControls.js'
import { resolveCameraPose } from './PlacementScheduler.js'

const _authVegFocus = { x: 0, y: 0, z: 0 }
const _camPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
const _authBenderTmp = { x: 0, y: 0, z: 0 }
const _BENDER_POOL_SIZE = 64
const _benderPool = Array.from({ length: _BENDER_POOL_SIZE }, () => ({ x: 0, z: 0, distSq: 0 }))
const _benderScratch = []
const _benderAuthTmp = { x: 0, y: 0, z: 0 }
const GRASS_BEND_MAX_RADIUS_M = 60
const ALTITUDE_INDEPENDENT_NEAR_M = 0.3

let _vcCtx = null
const _setModelPoolBudget = n => _vcCtx.modelPool.setOcclusionQueryBudget(n)
const _setTerrainBudget = n => _vcCtx.terrainBackdrop.setOcclusionQueryBudget(n)
const _setSceneBudget = n => _vcCtx.sceneOcclusion.setMaxQueriesPerFrame(n)

export function buildRenderSectionNodes() {
  return [
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
        const wantNear = ALTITUDE_INDEPENDENT_NEAR_M
        const wantFar = Math.min(Math.max(vegFar, 100), distToCenter)
        ctx.res.hostNearFar = { near: wantNear, far: wantFar }
        if (typeof window !== 'undefined') window.__hostNearFar = ctx.res.hostNearFar
      },
    },

    {
      id: 'terrain-depth-color',
      reads: ['hostNearFar'],
      writes: ['camera-context', 'terrainDepth', 'terrainColor'],
      targets: { terrainDepth: 'canvas', terrainColor: 'canvas' },
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

    {
      id: 'foliage-lod-sync',
      reads: ['cameraSynced'],
      writes: [],
      shouldRun: ctx => !!(ctx.vegetation || ctx.rocks || ctx.grass),
      run(ctx) {
        const _windDt = ctx.res.frameDt || 0
        const veg = ctx.vegetation, rocks = ctx.rocks, grass = ctx.grass
        if (veg && typeof veg.tickWind === 'function') { try { veg.tickWind(_windDt) } catch (_) {} }
        if (grass && typeof grass.tickWind === 'function') { try { grass.tickWind(_windDt) } catch (_) {} }
        const pose = resolveCameraPose(ctx.camera, _camPose)
        const shadowMoved = ctx.res.shadowMoved || false
        const shadowStill = (veg && veg.castShadows) ? !shadowMoved : true
        const tick = !(ctx.placementScheduler && !ctx.placementScheduler.shouldTick(ctx.now))
        if (tick) {
          const frameDt = ctx.res.frameDt || 0
          let vegFocus = ctx.res.vegFocus || ctx.camera.position
          if (ctx.floatingOrigin) {
            vegFocus = ctx.floatingOrigin.toAuthoritative(vegFocus.position ? { x: vegFocus.position[0], y: vegFocus.position[1], z: vegFocus.position[2] } : vegFocus, _authVegFocus)
          }
          if (veg) {
            try { if (typeof veg.updateStreaming === 'function') veg.updateStreaming(frameDt, ctx.camera, vegFocus, pose); else if (typeof veg.update === 'function') veg.update(frameDt, ctx.camera, vegFocus, shadowStill) } catch (_) {}
          }
          if (rocks) {
            try { if (typeof rocks.updateStreaming === 'function') rocks.updateStreaming(frameDt, ctx.camera, vegFocus, pose); else if (typeof rocks.update === 'function') rocks.update(frameDt, ctx.camera, vegFocus) } catch (_) {}
          }
          if (grass) {
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
                if (_poolN >= _BENDER_POOL_SIZE) continue
                const row = _benderPool[_poolN++]
                row.x = wx; row.z = wz; row.distSq = distSq
                _benderScratch.push(row)
              }
              if (_benderScratch.length > 1) _benderScratch.sort((a, b) => a.distSq - b.distSq)
            }
            try { if (typeof grass.updateStreaming === 'function') grass.updateStreaming(frameDt, ctx.camera, vegFocus, _benderScratch, pose); else if (typeof grass.update === 'function') grass.update(frameDt, ctx.camera, vegFocus, _benderScratch) } catch (_) {}
          }
        }
        if (veg && typeof veg.updateVisibility === 'function') { try { veg.updateVisibility(ctx.camera, pose, shadowStill) } catch (_) {} }
        if (rocks && typeof rocks.updateVisibility === 'function') { try { rocks.updateVisibility(ctx.camera, pose) } catch (_) {} }
        if (grass && typeof grass.updateVisibility === 'function') { try { grass.updateVisibility(ctx.camera, pose) } catch (_) {} }
      },
    },

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

    {
      id: 'visibility-commit',
      reads: ['sceneDepth'],
      writes: ['occlusionCommitted'],
      terminal: true,
      run(ctx) {
        const budget = ctx.occlusionQueryBudget
        _vcCtx = ctx
        if (ctx.modelPool && ctx.modelPool.setOcclusionQueryBudget) {
          budget?.apply('modelPool', _setModelPoolBudget)
        }
        ctx.modelPool.runOcclusionQueries?.()
        if (budget && ctx.modelPool) {
          try { budget.reportCandidates('modelPool', ctx.modelPool.getCandidateCount ? ctx.modelPool.getCandidateCount() : ctx.modelPool.getStats().candidates) } catch (_) {}
        }
        if (ctx.terrainBackdrop) {
          if (budget && ctx.terrainBackdrop.setOcclusionQueryBudget) budget.apply('terrain', _setTerrainBudget)
          ctx.terrainBackdrop.runOcclusionQueries?.()
          if (budget && ctx.terrainBackdrop.getOcclusionStats) {
            try { budget.reportCandidates('terrain', ctx.terrainBackdrop.getOcclusionCandidateCount ? ctx.terrainBackdrop.getOcclusionCandidateCount() : ctx.terrainBackdrop.getOcclusionStats().candidates) } catch (_) {}
          }
        }
        if (budget) budget.apply('scene', _setSceneBudget)
        ctx.sceneOcclusion.runQueries(ctx.camera)
        if (budget) {
          try { budget.reportCandidates('scene', ctx.sceneOcclusion.getCandidateCount()) } catch (_) {}
        }
        ctx.res.occlusionCommitted = ctx.frameId
      },
    },
  ]
}
