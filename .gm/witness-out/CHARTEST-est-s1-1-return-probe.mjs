import { createPlanetFrame } from '/workspace/spoint/src/terrain/PlanetFrame.js';
const frame = createPlanetFrame({ sampler: { heightAt: () => 0 }, anchorDir: [0, 1, 0], offsetY: 0 });
const out = {};
for (const [name, fn] of Object.entries({ nanReturn: (x, z, y) => NaN, stringReturn: (x, z, y) => 'x' })) {
  try { frame.registerGroundSource(name, fn); out[name] = 'accepted' } catch (e) { out[name] = 'threw: ' + e.message.slice(0, 90) }
}
console.log(JSON.stringify(out));
