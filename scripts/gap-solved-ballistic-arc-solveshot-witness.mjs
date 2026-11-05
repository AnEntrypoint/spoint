import { solveShot, elevation } from '../src/shared/ballistics.js';

const results = [];
function expect(name, ok, detail = '') {
  results.push(ok === true);
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const G = 10;
const ORIGIN = { x: 0, y: 0, z: 0 };
const positionAt = (shot, t) => ({
  x: shot.vel.x * t,
  y: shot.vel.y * t - 0.5 * G * t * t,
  z: shot.vel.z * t,
});

const flat = elevation(20, G, 40, 0);
expect('flat 45 degree range gives pi/4', flat !== null && near(flat, Math.PI / 4), `angle=${flat}`);

const low = elevation(20, G, 20, 0);
expect('low-angle solution is returned for the same range', low !== null && near(low, Math.PI / 12), `angle=${low}`);

expect('unreachable range returns null', elevation(5, G, 100, 0) === null);

expect('zero distance returns null', elevation(20, G, 0, 0) === null);

const flatShot = solveShot(ORIGIN, { x: 40, y: 0, z: 0 }, 20, G);
expect('flat shot solves', flatShot !== null);
if (flatShot) {
  expect('flat shot launch velocity components', near(flatShot.vel.x, 20 * Math.SQRT1_2) && near(flatShot.vel.y, 20 * Math.SQRT1_2) && near(flatShot.vel.z, 0), `vel=${JSON.stringify(flatShot.vel)}`);
  const end = positionAt(flatShot, flatShot.time);
  expect('flat shot lands on the target', near(end.x, 40, 1e-6) && near(end.y, 0, 1e-6), `end=${JSON.stringify(end)}`);
}

const liftTarget = { x: 30, y: 5, z: 0 };
const lifted = solveShot(ORIGIN, liftTarget, 20, G);
expect('elevated target solves', lifted !== null);
if (lifted) {
  const hit = positionAt(lifted, lifted.time);
  expect('elevated shot passes through the target', near(hit.x, 30, 1e-6) && near(hit.y, 5, 1e-6), `hit=${JSON.stringify(hit)}`);
}

const diagonal = solveShot(ORIGIN, { x: 0, y: 0, z: 40 }, 20, G);
expect('shot along z points along z', diagonal !== null && near(diagonal.vel.x, 0) && diagonal.vel.z > 0);

expect('unreachable target returns null', solveShot(ORIGIN, { x: 100, y: 0, z: 0 }, 5, G) === null);

expect('coincident target returns null', solveShot(ORIGIN, ORIGIN, 20, G) === null);

let refused = false;
try {
  solveShot(ORIGIN, { x: 10, y: 0, z: 0 }, 0, G);
} catch (err) {
  refused = err instanceof RangeError;
}
expect('non-positive speed is refused', refused);

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`checks ${results.length} passed ${passed} failed ${failed}`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
