import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

const WITNESS_NAME = 'StreamingGltfModelPool';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultModulePath = path.resolve(repoRoot, 'packages', 'streaming-gltf', 'src', 'model-pool.js');
const defaultOutDir = path.resolve(repoRoot, '.gm', 'witness-out');
const ASSET_URL = 'asset://streaming-cluster/malformed.cluster.glb';
const BATCHER_OPTIONS = { maxInstances: 4, maxVerts: 64, maxIndex: 64 };
const MALFORMED_STREAM = [{ stream: 2, offset: 0, count: 3 }];
const MALFORMED_RANGE = [{ stream: 0, offset: 0, count: 99 }];
const WELL_FORMED = [{ stream: 0, offset: 0, count: 3 }];

const claims = [];
const output = [];
const warnings = [];

console.warn = (...parts) => {
  warnings.push(parts.map((part) => String(part)).join(' '));
};

function emit(line) {
  output.push(line);
  process.stdout.write(line + '\n');
}

function claim(title, check) {
  claims.push({ title: title, check: check });
}

function expectEqual(actual, expected, what) {
  if (!Object.is(actual, expected)) {
    throw new Error(what + ': expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
  }
}

function expectTrue(condition, what) {
  if (!condition) {
    throw new Error(what + ': condition is false');
  }
}

function readFlag(argv, name) {
  const prefix = '--' + name + '=';
  const hit = argv.find((arg) => arg.indexOf(prefix) === 0);
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function resolveModulePath(argv) {
  const flagged = readFlag(argv, 'module');
  if (flagged !== undefined) {
    return path.resolve(process.cwd(), flagged);
  }
  const positional = argv.find((arg) => arg.indexOf('--') !== 0);
  if (positional !== undefined) {
    return path.resolve(process.cwd(), positional);
  }
  return defaultModulePath;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function labelFor(index) {
  return 'C' + String(index + 1).padStart(2, '0');
}

function makeCluster(lods) {
  const position = new THREE.BufferAttribute(new Float32Array(9), 3);
  return {
    materialBucket: 'bucket-a',
    material: new THREE.MeshStandardMaterial(),
    matrixWorld: new THREE.Matrix4(),
    visible: true,
    prepare: () => {},
    geometry: {
      index: new THREE.BufferAttribute(Uint32Array.from([0, 1, 2]), 1),
      attributes: { position: position },
      boundingSphere: new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1),
    },
    lod0Count: 3,
    clusterSet: { clusters: [{ lods: lods }] },
  };
}

function makeHarness(ctx) {
  const pool = {
    _nextEntityId: 0,
    _entities: new Set(),
    _materialBucketPx: 1e9,
    _useImpostorFinalLod: false,
    _useMaterialBucketBatching: true,
    _lastTick: 0,
    scene: new THREE.Scene(),
    _materialBucketBatcher: null,
    _getMaterialBucketBatcher() {
      return this._materialBucketBatcher;
    },
  };
  pool._materialBucketBatcher = new ctx.batcherMod.MaterialBucketBatcher(pool, BATCHER_OPTIONS);
  return pool;
}

function spawnEntity(ctx, pool, cluster) {
  const proxy = new EventEmitter();
  proxy.root = new THREE.Object3D();
  const item = {
    asset: { url: ASSET_URL, ready: new Promise(() => {}) },
    opts: {},
    proxy: proxy,
    placeholder: { _disposed: false },
  };
  ctx.mod.ModelPool.prototype._materializeSpawn.call(pool, item);
  const entity = proxy.actualEntity;
  entity.clusterMeshes = [cluster];
  entity.trackedMeshes = [{ mesh: new THREE.Object3D() }];
  return entity;
}

const camera = { position: new THREE.Vector3(0, 0, 10), fov: 60 };

function frame(entity) {
  return entity._update(camera, 1000, 0, 0, null, 0);
}

function poolWarnings() {
  return warnings.filter((line) => line.indexOf('[model-pool]') >= 0);
}

claim('the module exports ModelPool with the materialize step the spawn queue runs', (ctx) => {
  expectEqual(typeof ctx.mod.ModelPool, 'function', 'ModelPool export');
  expectEqual(typeof ctx.mod.ModelPool.prototype._materializeSpawn, 'function', '_materializeSpawn');
});

claim('a malformed coarse LOD leaves the caller on the cluster path: no throw, tracked draws visible, nothing bucketed', (ctx) => {
  for (const [label, lods] of [['stream', MALFORMED_STREAM], ['range', MALFORMED_RANGE]]) {
    const pool = makeHarness(ctx);
    const cluster = makeCluster(lods);
    const entity = spawnEntity(ctx, pool, cluster);
    const tracked = entity.trackedMeshes[0].mesh;
    let result = null;
    let thrown = null;
    try {
      result = frame(entity);
    } catch (error) {
      thrown = error;
    }
    expectTrue(thrown === null, label + ' LOD: the caller threw ' + (thrown && thrown.message));
    expectEqual(result.tier, 'cluster', label + ' LOD tier');
    expectEqual(tracked.visible, true, label + ' LOD tracked draws visible');
    expectEqual(cluster.visible, true, label + ' LOD cluster visible');
    expectEqual(pool._materialBucketBatcher.stats.instanceCount, 0, label + ' LOD instances');
    expectEqual(pool._materialBucketBatcher.stats.bucketCount, 0, label + ' LOD buckets');
  }
});

claim('a rejected malformed LOD is attempted once and warned once across frames, then stays on the cluster path', (ctx) => {
  const pool = makeHarness(ctx);
  const batcher = pool._materialBucketBatcher;
  const acquire = batcher.acquire.bind(batcher);
  let attempts = 0;
  batcher.acquire = (...args) => {
    attempts += 1;
    return acquire(...args);
  };
  const entity = spawnEntity(ctx, pool, makeCluster(MALFORMED_STREAM));
  for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
    expectEqual(frame(entity).tier, 'cluster', 'tier at frame ' + frameIndex);
  }
  expectEqual(attempts, 1, 'acquire attempts across four frames');
  const logged = poolWarnings();
  expectEqual(logged.length, 1, 'model-pool warnings across four frames');
  expectTrue(logged[0].indexOf('is not an index stream') >= 0, 'warning names the malformed LOD: ' + logged[0]);
  expectEqual(entity.trackedMeshes[0].mesh.visible, true, 'tracked draws visible after four frames');
});

claim('an error other than a RangeError still propagates from the caller, with tracked draws and cluster restored', (ctx) => {
  const pool = makeHarness(ctx);
  pool._materialBucketBatcher.acquire = () => {
    throw new Error('acquire-boom');
  };
  const entity = spawnEntity(ctx, pool, makeCluster(WELL_FORMED));
  let thrown = null;
  try {
    frame(entity);
  } catch (error) {
    thrown = error;
  }
  expectTrue(thrown !== null && thrown.message === 'acquire-boom', 'the acquire error reaches the caller: ' + (thrown && thrown.message));
  expectEqual(entity.trackedMeshes[0].mesh.visible, true, 'tracked draws visible after the rethrow');
  expectEqual(entity.clusterMeshes[0].visible, true, 'cluster visible after the rethrow');
});

claim('a well-formed coarse LOD still buckets the entity and hides its tracked draws', (ctx) => {
  const pool = makeHarness(ctx);
  const cluster = makeCluster(WELL_FORMED);
  const entity = spawnEntity(ctx, pool, cluster);
  expectEqual(frame(entity).tier, 'material-bucket', 'tier');
  expectEqual(pool._materialBucketBatcher.stats.instanceCount, 1, 'bucketed instances');
  expectEqual(entity.trackedMeshes[0].mesh.visible, false, 'tracked draws hidden while bucketed');
  expectEqual(cluster.visible, false, 'cluster hidden while bucketed');
});

async function runClaims(ctx) {
  let failedClaims = 0;
  for (let index = 0; index < claims.length; index += 1) {
    warnings.length = 0;
    try {
      await claims[index].check(ctx);
      emit('CLAIM ' + labelFor(index) + ' PASS ' + claims[index].title);
    } catch (error) {
      failedClaims += 1;
      emit('CLAIM ' + labelFor(index) + ' FAIL ' + claims[index].title + ' :: ' + (error && error.message));
    }
  }
  return failedClaims;
}

async function main(argv, runId) {
  const modulePath = resolveModulePath(argv);
  const moduleExists = fs.existsSync(modulePath);
  const moduleSha = moduleExists ? sha256Hex(fs.readFileSync(modulePath)) : 'none';
  emit('RUN_IDENTITY utc=' + new Date().toISOString() + ' run_id=' + runId + ' witness=' + WITNESS_NAME + ' module=' + modulePath + ' module_sha256=' + moduleSha);
  if (!moduleExists) {
    emit('MODULE_MISSING ' + modulePath);
    emit('RESULT: FAIL checks=0 failed=1 correct=0 characterized=0');
    return 1;
  }
  let ctx;
  try {
    ctx = {
      mod: await import(pathToFileURL(modulePath).href),
      batcherMod: await import(pathToFileURL(path.join(path.dirname(modulePath), 'material-bucket-batcher.js')).href),
    };
  } catch (error) {
    emit('MODULE_LOAD_ERROR ' + (error && error.message));
    emit('RESULT: FAIL checks=0 failed=1 correct=0 characterized=0');
    return 1;
  }
  const failed = await runClaims(ctx);
  const total = claims.length;
  emit('CLAIMS ' + (total - failed) + '/' + total + ' passed');
  emit('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL') + ' checks=' + total + ' failed=' + failed + ' correct=' + total + ' characterized=0');
  return failed === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const compactUtc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z');
const runId = (readFlag(argv, 'run-id') || process.env.WITNESS_RUN_ID || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
const outFlag = readFlag(argv, 'out');
const outPath = outFlag !== undefined
  ? path.resolve(process.cwd(), outFlag)
  : path.join(defaultOutDir, WITNESS_NAME + '-' + compactUtc + '-' + runId.slice(0, 8) + '.txt');

main(argv, runId)
  .catch((error) => {
    emit('WITNESS_ERROR ' + (error && error.message));
    emit('RESULT: FAIL checks=0 failed=1 correct=0 characterized=0');
    return 1;
  })
  .then((code) => {
    const text = output.join('\n') + '\n';
    let exitCode = code;
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text, { flag: 'wx' });
      process.stdout.write('OUT ' + outPath + ' sha256=' + sha256Hex(Buffer.from(text, 'utf8')) + '\n');
    } catch (error) {
      process.stderr.write('OUT_WRITE_FAILED ' + (error && error.message) + '\n');
      exitCode = 1;
    }
    process.exitCode = exitCode;
  });
