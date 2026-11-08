import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { exitAfterQuiesce } from './lib/quiesce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_POOL = path.join(ROOT, 'packages/streaming-gltf/src/model-pool.js');
const { ModelPool } = await import(pathToFileURL(MODEL_POOL).href);

const fetchedUrls = [];
globalThis.fetch = async (url) => {
  fetchedUrls.push(String(url));
  return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
};

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

const settle = () => new Promise((r) => setTimeout(r, 25));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
};

const cacheUrl = 'http://witness.invalid/rejected-asset.glb';
const pool1 = new ModelPool({});
const rejected = await pool1._resolveAsset(cacheUrl);
await rejected.ready.catch(() => {});
await settle();
const reResolved = await pool1._resolveAsset(cacheUrl);
check(
  'rejected asset is not served from the cache',
  reResolved !== rejected && fetchedUrls.filter((u) => u === cacheUrl).length >= 2,
  `same object: ${reResolved === rejected}; fetches of url: ${fetchedUrls.filter((u) => u === cacheUrl).length}`,
);

unhandled.length = 0;
const pool2 = new ModelPool({});
const queueKey = 'witness:failing-queued-load';
const queued = pool2._enqueue(queueKey, async () => { throw new Error('witness queued load failure'); });
await queued.catch(() => {});
await settle();
check('failed queued load raises no unhandled rejection', unhandled.length === 0, `unhandled: ${unhandled.length}`);
check('failed queued load leaves the load queue', !pool2._loadQueue.has(queueKey));

const pool3 = new ModelPool({});
const lodAssetUrl = 'http://witness.invalid/lod-asset.glb';
const lodAsset = await pool3._resolveAsset(lodAssetUrl);
await lodAsset.ready.catch(() => {});
lodAsset.baseDir = 'http://witness.invalid/';
lodAsset.meshLodDescs = [{
  meshIndex: 0,
  primIndex: 0,
  lods: [{ kind: 'textured', path: 'coarse.glb' }, { kind: 'textured', path: 'fine.glb' }],
}];
const coarseGeometry = { isBufferGeometry: true, witness: 'coarse' };
lodAsset.geoCache.set('0:0:0', coarseGeometry);
let lodResult = null;
let lodError = null;
try {
  lodResult = await lodAsset.ensureMeshLod(0, 1);
} catch (err) {
  lodError = err;
}
check('failed LOD load is reported to the caller', lodError !== null, lodError ? String(lodError.message) : 'resolved');
check('failed LOD load is not silently replaced by a coarser LOD', lodResult !== coarseGeometry, lodResult === coarseGeometry ? 'coarse LOD returned' : '');
check('failed LOD load is not cached', !lodAsset.geoCache.has('0:0:1'));

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exitCode = failed.length === 0 ? 0 : 1;
await exitAfterQuiesce(process.exitCode);
