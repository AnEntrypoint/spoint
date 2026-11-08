import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LodUnloadManager } = await import(
  pathToFileURL(path.join(ROOT, 'packages/streaming-gltf/src/lod-unload-manager.js')).href
);

const MB = 1024 * 1024;
const LOD_BYTES = 4 * MB;
const CURRENT_VRAM_BYTES = 10 * MB;

function makeAsset(url) {
  const evicted = [];
  return {
    url,
    meshLodDescs: [{ lods: [{ bytes: LOD_BYTES }, { bytes: LOD_BYTES }] }],
    texLodDescs: [],
    evicted,
    evictMeshLod(descIdx, lodIdx) {
      evicted.push(`${descIdx}:${lodIdx}`);
      return LOD_BYTES;
    },
    evictTexLod() {
      return null;
    },
  };
}

function invisibleEntity(asset, distance) {
  const entity = { asset, trackedMeshes: [] };
  if (distance !== undefined) entity._currentDistance = distance;
  return entity;
}

function runScan(entities) {
  const asset = makeAsset('unknown-distance.glb');
  const manager = new LodUnloadManager(1);
  for (const entity of entities(asset)) {
    entity.asset = asset;
    manager.markInvisible(entity);
  }
  manager.scanForUnload(new Map([[asset.url, asset]]), CURRENT_VRAM_BYTES);
  return asset.evicted;
}

const cases = [];

function check(name, pass, detail) {
  cases.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
}

const noDistance = runScan((asset) => [invisibleEntity(asset, undefined)]);
check(
  'entity with no recorded distance is not evicted',
  noDistance.length === 0,
  `evicted=${JSON.stringify(noDistance)}`,
);

const nanDistance = runScan((asset) => [invisibleEntity(asset, Number.NaN)]);
check(
  'entity with NaN distance is not evicted',
  nanDistance.length === 0,
  `evicted=${JSON.stringify(nanDistance)}`,
);

const unknownBesideFar = runScan((asset) => [invisibleEntity(asset, undefined), invisibleEntity(asset, 500)]);
check(
  'asset with an unknown-distance invisible entity is not evicted even beside a far entity',
  unknownBesideFar.length === 0,
  `evicted=${JSON.stringify(unknownBesideFar)}`,
);

const farDistance = runScan((asset) => [invisibleEntity(asset, 500)]);
check(
  'entity with a recorded far distance is evicted',
  farDistance.length > 0,
  `evicted=${JSON.stringify(farDistance)}`,
);

const failed = cases.filter((c) => !c.pass);
console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${cases.length - failed.length}/${cases.length} cases)`);
process.exit(failed.length === 0 ? 0 : 1);
