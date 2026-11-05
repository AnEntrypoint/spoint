import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(REPO_ROOT, 'src', 'sdk', 'ChaseCamera.js');
const { createChaseCamera, wrapAngle, CHASE_CAMERA_DEFAULTS } = await import(pathToFileURL(modulePath).href);

let failures = 0;
const expect = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const FEET = { x: 10, y: 0, z: -4 };
const CENTRE = { yaw: 0, pitch: 0 };
const DT = 1 / 120;

const cam = createChaseCamera();
const first = cam.update(DT, 0.8, FEET, CENTRE);
expect('first frame snaps heading to hull yaw', near(first.frameYaw, 0.8, 1e-9), `frameYaw=${first.frameYaw}`);

const eased = createChaseCamera();
eased.update(DT, 0, FEET, CENTRE);
const step1 = eased.update(DT, 1, FEET, CENTRE).frameYaw;
expect('heading eases, does not jump to hull yaw', step1 > 0 && step1 < 1, `step1=${step1}`);

const converge = createChaseCamera();
converge.update(DT, 0, FEET, CENTRE);
let last = 0;
let monotone = true;
for (let i = 0; i < 240; i += 1) {
  const f = converge.update(DT, 1, FEET, CENTRE).frameYaw;
  if (f < last - 1e-12) monotone = false;
  last = f;
}
expect('heading converges monotonically to target', monotone && near(last, 1, 1e-3), `final=${last}`);

const wrap = createChaseCamera();
wrap.update(DT, Math.PI - 0.05, FEET, CENTRE);
const across = wrap.update(DT, -Math.PI + 0.05, FEET, CENTRE).frameYaw;
const seamStep = wrapAngle(across - (Math.PI - 0.05));
expect('heading crosses the +-pi seam the short way', seamStep > 0 && seamStep < 0.1, `seamStep=${seamStep}`);

const held = createChaseCamera();
held.update(DT, 0, FEET, { yaw: 0.9, pitch: 0 });
let heldFrame = null;
for (let i = 0; i < Math.round(CHASE_CAMERA_DEFAULTS.restSeconds / DT) - 2; i += 1) heldFrame = held.update(DT, 0, FEET, { yaw: 0.9, pitch: 0 });
expect('mouse look is not recentred during the rest window', near(heldFrame.frameYaw, 0, 1e-9), `frameYaw=${heldFrame.frameYaw}`);

const recentre = createChaseCamera();
recentre.update(DT, 0, FEET, { yaw: 0.9, pitch: 0 });
let rec = null;
for (let i = 0; i < 600; i += 1) rec = recentre.update(DT, 0, FEET, { yaw: 0.9, pitch: 0 });
const viewYaw = rec.frameYaw + 0.9;
expect('idle look eases the view back onto the hull heading', near(viewYaw, 0, 1e-3), `viewYaw=${viewYaw}`);

const pitched = createChaseCamera().update(DT, 0, FEET, { yaw: 0, pitch: 0 });
const horiz = Math.hypot(pitched.eye.x - FEET.x, pitched.eye.z - FEET.z);
expect('eye sits at the configured distance behind the hull', near(horiz, CHASE_CAMERA_DEFAULTS.dist, 1e-9), `horiz=${horiz}`);
expect('eye is behind the hull at yaw 0 (faces -Z, so eye z > feet z)', pitched.eye.z > FEET.z, `eye.z=${pitched.eye.z}`);
expect('look target is the aim point above the feet', near(pitched.lookAt.y - FEET.y, CHASE_CAMERA_DEFAULTS.aim, 1e-9));

const up = createChaseCamera().update(DT, 0, FEET, { yaw: 0, pitch: 0.4 });
expect('positive pitch lowers the eye (look up orbits below)', up.eye.y < FEET.y + CHASE_CAMERA_DEFAULTS.height, `eye.y=${up.eye.y}`);

const zero = createChaseCamera();
zero.update(DT, 0.3, FEET, CENTRE);
const still = zero.update(0, 0.3, FEET, CENTRE);
expect('zero dt keeps heading finite', Number.isFinite(still.frameYaw) && near(still.frameYaw, 0.3, 1e-9));

expect('wrapAngle maps 3pi/2 to -pi/2', near(wrapAngle(3 * Math.PI / 2), -Math.PI / 2, 1e-9));

const scan = createChaseCamera();
let finite = true;
for (let i = 0; i < 2000; i += 1) {
  const r = scan.update(DT, Math.sin(i * 0.05) * 3, FEET, { yaw: Math.sin(i * 0.2), pitch: 0.2 });
  if (!Number.isFinite(r.frameYaw) || !Number.isFinite(r.eye.x) || !Number.isFinite(r.eye.y) || !Number.isFinite(r.eye.z)) finite = false;
}
expect('long random run stays finite', finite);

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failed)`);
  process.exit(1);
}
console.log('RESULT: PASS');
process.exit(0);
