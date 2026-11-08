import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`) };
const finish = (label, pass) => { const failed = checks.filter((c) => !c.ok); console.log(failed.length === 0 ? `RESULT: PASS ${label}` : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`); process.exitCode = failed.length === 0 ? 0 : 1 };
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { parseWorldDef } = await mod('apps/world/_shared/worldDefParse.js');
const codeOf = (fn) => { try { fn(); return 'ok' } catch (e) { return e.code || String(e) } };
check('a non-object world def refuses with world-def-not-an-object', codeOf(() => parseWorldDef('w', 'nope')) === 'world-def-not-an-object');
check('an unknown top-level field refuses with world-field-unknown', codeOf(() => parseWorldDef('w', { planetRadius: 0, notAField: 1 })) === 'world-field-unknown');
check('a missing planetRadius refuses with world-planet-radius-not-declared', codeOf(() => parseWorldDef('w', {})) === 'world-planet-radius-not-declared');
check('a string planetRadius refuses with world-planet-radius-not-a-number', codeOf(() => parseWorldDef('w', { planetRadius: '6000' })) === 'world-planet-radius-not-a-number');
check('a negative planetRadius refuses with world-planet-radius-not-a-number', codeOf(() => parseWorldDef('w', { planetRadius: -1 })) === 'world-planet-radius-not-a-number');
finish('parseWorldDef refuses bad worlds with coded errors', true);
