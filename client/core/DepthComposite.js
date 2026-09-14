import { RenderControls } from './RenderControls.js'

export function checkDepthComposite(camera) {
  const issues = []
  const depthToCanvas = RenderControls.get('planetDepthToCanvas')
  const bias = RenderControls.get('planetDepthBias')
  const hostNearFar = (typeof window !== 'undefined') ? window.__hostNearFar : null
  if (depthToCanvas !== true) issues.push('planetDepthToCanvas is not true -- THREE geometry will draw over terrain instead of being occluded by it')
  if (!hostNearFar) issues.push('window.__hostNearFar not published yet (terrain not initialised?)')
  else {
    if (!(hostNearFar.near < hostNearFar.far)) issues.push(`hostNearFar near(${hostNearFar.near}) >= far(${hostNearFar.far}) -- depth encoding is degenerate`)
    if (camera && (Math.abs(camera.near - hostNearFar.near) > 1e-6 || Math.abs(camera.far - hostNearFar.far) > 1e-3)) {
      issues.push(`THREE camera near/far (${camera.near},${camera.far}) != hostNearFar (${hostNearFar.near},${hostNearFar.far}) -- the two depth buffers are on different curves`)
    }
  }
  if (typeof bias !== 'number' || bias < 0) issues.push(`planetDepthBias (${bias}) invalid -- grounded geometry may z-fight the terrain`)
  const state = { planetDepthToCanvas: depthToCanvas, planetDepthBias: bias, hostNearFar, cameraNearFar: camera ? [camera.near, camera.far] : null }
  return { ok: issues.length === 0, issues, state }
}

export function installDepthCompositeCheck(camera) {
  if (typeof window !== 'undefined') window.__depthComposite = { check: () => checkDepthComposite(camera) }
}
