import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { exitAfterQuiesce } from './lib/quiesce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ModelPool } = await import(pathToFileURL(path.join(ROOT, 'packages/streaming-gltf/src/model-pool.js')).href);

globalThis.fetch = async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });

const settle = () => new Promise((r) => setTimeout(r, 25));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
};

const pool = new ModelPool({});
const asset = await pool._resolveAsset('http://witness.invalid/lod-warm-failure.glb');
await asset.ready.catch(() => {});
asset.meshLodDescs = [{ meshIndex: 0, primIndex: 0, lods: [{ kind: 'textured', path: 'fine.glb' }, { kind: 'textured', path: 'coarse.glb' }] }];
asset.ensureMeshLod = async () => { throw new Error('witness warm failure'); };

let notified = 0;
pool._enqueueLodWarm(asset, 0, 1, 5, () => { notified += 1; });
pool._enqueueLodWarm(asset, 0, 1, 3, () => { notified += 1; });
pool._drainLodWarm();
await settle();

check('a failed warm load notifies every entity waiting on it', notified === 2, `notified=${notified}`);
check('the warm queue and in-flight count settle after a failure', pool._lodWarmQueue.size === 0 && pool._lodWarmInFlight === 0, `queue=${pool._lodWarmQueue.size} inFlight=${pool._lodWarmInFlight}`);

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? 'RESULT: PASS a failed LOD warm load releases the entities that wait on it' : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
await exitAfterQuiesce(process.exitCode);
