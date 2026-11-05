
import { vec3 } from '/workspace/spoint/src/shared/vecGuard.js';
const out = {};
for (const [name, v] of Object.entries({ nan: [NaN, 0, 0], short: [1, 2], str: ['a', 0, 0] })) {
  try { vec3(v, 'position'); out[name] = 'accepted' } catch (e) { out[name] = 'threw: ' + e.message.slice(0, 80) }
}
console.log(JSON.stringify(out));