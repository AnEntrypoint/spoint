export { initMapspinnerPlanet } from './planet-orchestrator.js';
export { initMapspinnerRender } from './gl-render.js';
export { Quadtree } from './quadtree.js';
export { createAnchorField } from './anchor-field.js';
export { createHeightSampler, HEIGHT_UNIFORM_DEFAULTS } from './height-cpu.js';
export { TERRAIN_DEFAULTS, SHAPE_UNIFORM_DEFAULTS } from './terrain-defaults.js';

export const VERSION = '0.1.0';

export async function createRenderer(gl, config = {}) {
  const { initMapspinnerRender } = await import('./gl-render.js');
  return initMapspinnerRender(gl, config);
}

export async function createPlanet(gl, config = {}) {
  const { initMapspinnerPlanet } = await import('./planet-orchestrator.js');
  return initMapspinnerPlanet(gl, config);
}
