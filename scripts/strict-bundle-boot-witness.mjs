import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs';
await installSpecifierHooks();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`) };
const finish = (label) => { const failed = checks.filter((c) => !c.ok); console.log(failed.length === 0 ? `RESULT: PASS ${label}` : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`); process.exitCode = failed.length === 0 ? 0 : 1 };
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { buildStaticDirs } = await mod('src/sdk/ServerBoot.js');
const emptyRoot = mkdtempSync(path.join(tmpdir(), 'spoint-strict-empty-'));
const staleRoot = mkdtempSync(path.join(tmpdir(), 'spoint-strict-stale-'));
mkdirSync(path.join(staleRoot, 'dist', 'client'), { recursive: true });
writeFileSync(path.join(staleRoot, 'dist', 'client', 'app.js'), 'export {}\n');
writeFileSync(path.join(staleRoot, 'dist', 'client', 'app.bundlehash.json'), JSON.stringify({ hash: 'x', outputSha: '0'.repeat(64), inputs: [] }));
const realErr = console.error;
const realLog = console.log;
console.error = () => {}; console.log = () => {};
const boots = (root, strict) => {
  const prev = process.env.SPOINT_STRICT_BUNDLE;
  if (strict) process.env.SPOINT_STRICT_BUNDLE = '1'; else delete process.env.SPOINT_STRICT_BUNDLE;
  try { buildStaticDirs(root, root, []); return { threw: false } } catch (e) { return { threw: true, flagged: e.spointStaleBundle === true } } finally { if (prev === undefined) delete process.env.SPOINT_STRICT_BUNDLE; else process.env.SPOINT_STRICT_BUNDLE = prev }
};
try {
  const staleStrict = boots(staleRoot, true);
  check('strict boot refuses a stale client bundle', staleStrict.threw && staleStrict.flagged, JSON.stringify(staleStrict));
  check('non-strict boot serves past a stale client bundle', !boots(staleRoot, false).threw);
  const absentStrict = boots(emptyRoot, true);
  check('strict boot refuses an absent client and worker bundle', absentStrict.threw && absentStrict.flagged, JSON.stringify(absentStrict));
  check('non-strict boot serves past an absent bundle', !boots(emptyRoot, false).threw);
} finally {
  console.error = realErr; console.log = realLog;
  rmSync(emptyRoot, { recursive: true, force: true });
  rmSync(staleRoot, { recursive: true, force: true });
}
finish('SPOINT_STRICT_BUNDLE refuses stale and absent bundles, non-strict serves');
