
import { createPlanetFrame } from '/workspace/spoint/src/terrain/PlanetFrame.js';
const frame = createPlanetFrame({ sampler: { heightAt: () => 0 }, anchorDir: [0, 1, 0], offsetY: 0 });
const out = {};
for (const [name, fn] of Object.entries({ twoArg: (x, z) => 1.5, threeArg: (x, z, y) => y })) {
  try { frame.registerGroundSource(name, fn); out[name] = 'accepted' } catch (e) { out[name] = 'threw: ' + e.message.slice(0, 90) }
}
console.log(JSON.stringify(out));