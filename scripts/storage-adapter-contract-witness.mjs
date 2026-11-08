import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`) };
const finish = (label, pass) => { const failed = checks.filter((c) => !c.ok); console.log(failed.length === 0 ? `RESULT: PASS ${label}` : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`); process.exitCode = failed.length === 0 ? 0 : 1 };
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { StorageAdapter } = await mod('src/storage/StorageAdapter.js');
const a = new StorageAdapter();
for (const m of ['get', 'set', 'delete', 'list', 'has']) {
  const args = m === 'set' ? ['k', 'v'] : ['k'];
  let msg = null;
  try { await a[m](...args) } catch (e) { msg = e.message }
  check(`StorageAdapter.${m} throws not implemented on the base class`, msg === 'not implemented', String(msg));
}
class Mem extends StorageAdapter { constructor() { super(); this.m = new Map() } async get(k) { return this.m.get(k) } async set(k, v) { this.m.set(k, v) } async has(k) { return this.m.has(k) } async delete(k) { this.m.delete(k) } async list(p = '') { return [...this.m.keys()].filter((k) => k.startsWith(p)) } }
const mem = new Mem();
await mem.set('a/1', 9);
check('a subclass implementing the five methods round-trips a value', (await mem.get('a/1')) === 9 && (await mem.has('a/1')) === true && (await mem.list('a/')).length === 1);
finish('StorageAdapter contract: base class refuses, subclass works', true);
