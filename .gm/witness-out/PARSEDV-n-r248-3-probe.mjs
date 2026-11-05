import { spawnSurfaceY } from '/workspace/spoint/src/shared/SpawnSurface.js';
const out = {};
const floor = (o, d) => d[1] < 0 ? { hit: true, position: [o[0], 0, o[2]], normal: [0, 1, 0] } : { hit: false };
const run = (name, f) => { try { out[name] = f(); } catch (e) { out[name] = e.name + ': ' + e.message.slice(0, 80); } };
run('validFloor', () => spawnSurfaceY(floor, [0, 0, 0], { standingOffset: 1 }));
run('badArgs', () => spawnSurfaceY(floor, [0, NaN, 0], { standingOffset: 1 }));
run('noSurface', () => spawnSurfaceY(() => ({ hit: false }), [0, 0, 0], { standingOffset: 1 }));
run('malformedHit', () => spawnSurfaceY(() => ({ hit: true, position: [0, NaN, 0], normal: [0, 1, 0] }), [0, 0, 0], { standingOffset: 1 }));
console.log(JSON.stringify(out));