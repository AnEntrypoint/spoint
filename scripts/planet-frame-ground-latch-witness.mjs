import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`) };
const finish = (label, pass) => { const failed = checks.filter((c) => !c.ok); console.log(failed.length === 0 ? `RESULT: PASS ${label}` : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`); process.exitCode = failed.length === 0 ? 0 : 1 };
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { guardedGroundHeight, NoGroundHeightError, NO_GROUND_HEIGHT } = await mod('packages/../src/terrain/PlanetFrame.js');
const realWarn = console.warn;
let warns = [];
console.warn = (...a) => { warns.push(String(a[0])) };
const failing = (x, z) => { throw new NoGroundHeightError(x, z) };
const terrainWarns = () => warns.filter((w) => w.startsWith('[terrain]')).length;
try {
  const first = guardedGroundHeight('witness ground probe', failing);
  const a = first(1, 2);
  const b = first(3, 4);
  check('a failed solve returns the NO_GROUND_HEIGHT sentinel, not a throw', a === NO_GROUND_HEIGHT && b === NO_GROUND_HEIGHT);
  check('one closure warns once for its first failure', terrainWarns() === 1, `warns=${terrainWarns()}`);
  warns = [];
  const rebuilt = guardedGroundHeight('witness ground probe', failing);
  rebuilt(5, 6);
  check('a closure rebuilt with the same where warns on its own first failure', terrainWarns() === 1, `warns=${terrainWarns()}`);
  warns = [];
  let rethrown = null;
  try { guardedGroundHeight('witness other', () => { throw new TypeError('not a solve error') })(0, 0) } catch (e) { rethrown = e }
  check('a non-solve error is rethrown', rethrown instanceof TypeError);
} finally { console.warn = realWarn }
finish('a rebuilt guarded closure reports its own first ground failure', true);
