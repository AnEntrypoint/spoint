import * as THREE from 'three';
import { MaterialBucketBatcher } from '../packages/streaming-gltf/src/material-bucket-batcher.js';

const CODE_EXHAUSTED = 'material-bucket-capacity-exhausted';
const failures = [];

function check(name, ok, detail) {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} ${detail ?? ''}`.trimEnd());
  if (!ok) failures.push(name);
}

function clusterOf(n, { normal = true } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  if (normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from({ length: n }, (_, i) => i), 1));
  return {
    geometry,
    lod0Count: n,
    clusterSet: { clusters: [{ lods: [{ stream: 0, offset: 0, count: n }] }] },
  };
}

function newBatcher(opts) {
  return new MaterialBucketBatcher({ scene: null }, opts);
}

const material = new THREE.MeshBasicMaterial();

{
  const batcher = newBatcher({ maxInstances: 8, maxVerts: 4, maxIndex: 4 });
  batcher.acquire({}, 'geo-capacity', 'g1', clusterOf(3), material);
  let id = null;
  let error = null;
  try {
    id = batcher.acquire({}, 'geo-capacity', 'g2', clusterOf(3), material);
  } catch (e) {
    error = e;
  }
  check('capacity-geometry-succeeds', error === null && Number.isInteger(id) && id >= 0, `id=${id} error=${error?.message ?? 'none'}`);
  check('capacity-geometry-grows-once', batcher.maxVerts === 8 && batcher.maxIndex === 8, `maxVerts=${batcher.maxVerts} maxIndex=${batcher.maxIndex}`);
}

{
  const batcher = newBatcher({ maxInstances: 8, maxVerts: 4, maxIndex: 4 });
  let error = null;
  try {
    batcher.acquire({}, 'geo-exhausted', 'g1', clusterOf(9), material);
  } catch (e) {
    error = e;
  }
  check('capacity-retry-failure-coded', error?.code === CODE_EXHAUSTED, `code=${error?.code ?? 'none'} message=${error?.message ?? 'none'}`);
  check('capacity-retry-failure-grows-once', batcher.maxVerts === 8 && batcher.maxIndex === 8, `maxVerts=${batcher.maxVerts} maxIndex=${batcher.maxIndex}`);
}

{
  const batcher = newBatcher({ maxInstances: 8, maxVerts: 4, maxIndex: 4 });
  batcher.acquire({}, 'geo-foreign', 'g1', clusterOf(3), material);
  let error = null;
  try {
    batcher.acquire({}, 'geo-foreign', 'g2', clusterOf(3, { normal: false }), material);
  } catch (e) {
    error = e;
  }
  check('non-capacity-geometry-surfaces', error instanceof Error && error.message.includes('missing'), `message=${error?.message ?? 'none'}`);
  check('non-capacity-geometry-capacity-unchanged', batcher.maxVerts === 4 && batcher.maxIndex === 4, `maxVerts=${batcher.maxVerts} maxIndex=${batcher.maxIndex}`);
}

{
  const batcher = newBatcher({ maxInstances: 2, maxVerts: 64, maxIndex: 64 });
  batcher.acquire({}, 'inst-foreign', 'g1', clusterOf(3), material);
  const bucket = batcher._buckets.get('inst-foreign');
  bucket.mesh.addInstance = () => {
    throw new Error('instance-boom');
  };
  let error = null;
  try {
    batcher.acquire({}, 'inst-foreign', 'g1', clusterOf(3), material);
  } catch (e) {
    error = e;
  }
  check('non-capacity-instance-surfaces', error?.message === 'instance-boom', `message=${error?.message ?? 'none'}`);
  check('non-capacity-instance-capacity-unchanged', batcher.maxInstances === 2, `maxInstances=${batcher.maxInstances}`);
}

{
  const batcher = newBatcher({ maxInstances: 2, maxVerts: 64, maxIndex: 64 });
  const ids = [{}, {}, {}].map((entity) => batcher.acquire(entity, 'inst-capacity', 'g1', clusterOf(3), material));
  check('capacity-instance-succeeds', ids.every((id) => Number.isInteger(id) && id >= 0), `ids=${ids.join(',')}`);
  check('capacity-instance-grows-once', batcher.maxInstances === 4, `maxInstances=${batcher.maxInstances}`);
}

if (failures.length > 0) {
  console.log(`RESULT: FAIL (${failures.length} checks: ${failures.join(', ')})`);
  process.exit(1);
}
console.log('RESULT: PASS');
process.exit(0);
