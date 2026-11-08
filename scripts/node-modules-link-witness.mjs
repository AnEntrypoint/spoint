import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs';
await installSpecifierHooks();
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`) };
const finish = (label, pass) => { const failed = checks.filter((c) => !c.ok); console.log(failed.length === 0 ? `RESULT: PASS ${label}` : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`); process.exitCode = failed.length === 0 ? 0 : 1 };
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { assertNodeModulesLinked } = await mod('src/sdk/ServerBoot.js');
const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const bare = mkdtempSync(path.join(tmpdir(), 'spoint-nm-bare-'));
const linked = mkdtempSync(path.join(tmpdir(), 'spoint-nm-linked-'));
mkdirSync(path.join(linked, 'node_modules'));
const realErr = console.error;
console.error = () => {};
try {
  let err = null;
  try { assertNodeModulesLinked(bare) } catch (e) { err = e }
  check('a checkout without node_modules throws', err !== null);
  check('the refusal carries spointNodeModulesMissing', err && err.spointNodeModulesMissing === true);
  let ok = true;
  try { assertNodeModulesLinked(linked) } catch { ok = false }
  check('a checkout with node_modules passes', ok);
} finally {
  console.error = realErr;
  rmSync(bare, { recursive: true, force: true });
  rmSync(linked, { recursive: true, force: true });
}
finish('node_modules link check refuses an unlinked checkout', true);
