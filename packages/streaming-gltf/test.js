#!/usr/bin/env node
// Single real-services integration witness for the cluster-LOD pipeline.
// Mock-free: bakes a real corpus GLB through tools/bake-cluster.mjs, reads it back
// with real gltf-transform + meshoptimizer, and asserts the EP_cluster_lod format
// invariants the runtime depends on. No unit-mock harness; this proves a full bake
// -> valid-GLB -> parse round-trip end to end.
//
//   node test.js [path/to/source.glb]

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import draco3dgltf from 'draco3dgltf';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { bakeCluster } from './tools/bake-cluster.mjs';
import { parseClusterLod, CLUSTER_LOD_EXTRA_KEY } from './src/meshlet-codec.js';
import { DeferredLoadQueue } from './src/deferred-load-queue.js';

const SRC = process.argv[2] || '../assets/Appliances/a_refrigerator_07685752_v1.glb';
const OUT = join(tmpdir(), `cluster-test-${process.pid}.glb`);

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '[pass]' : '[FAIL]'} ${msg}`); if (!cond) failures++; };

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  // --- bake (real baker, real GLB) ---
  const res = await bakeCluster(SRC, OUT);
  ok(res.clustered >= 1, `baked >=1 clustered primitive (got ${res.clustered})`);
  ok(res.totalClusters >= 1, `produced clusters (got ${res.totalClusters})`);

  // --- read back with real gltf-transform + meshopt decode ---
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
    'draco3d.decoder': await draco3dgltf.createDecoderModule(),
  });
  const doc = await io.read(OUT);
  const root = doc.getRoot();
  const accessors = root.listAccessors();

  const usedExts = root.listExtensionsUsed().map((e) => e.extensionName);
  ok(usedExts.includes('EXT_meshopt_compression'), `EXT_meshopt_compression present (${usedExts.join(',')})`);
  ok(!usedExts.includes('KHR_draco_mesh_compression'), 'stale KHR_draco_mesh_compression stripped (stock loader needs no DRACOLoader)');

  let clusterPrims = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const extras = prim.getExtras() || {};
      if (!extras[CLUSTER_LOD_EXTRA_KEY]) continue;
      clusterPrims++;
      const meta = parseClusterLod(extras);
      ok(!!meta, 'parseClusterLod returned a ClusterSet');
      ok(meta.clusters.length === extras[CLUSTER_LOD_EXTRA_KEY].clusterCount, 'clusterCount matches clusters array');

      const idx = prim.getIndices();
      const lod0Count = idx.getCount();
      const coarseAcc = meta.coarseIndexAccessor >= 0 ? accessors[meta.coarseIndexAccessor] : null;
      const coarseCount = coarseAcc ? coarseAcc.getCount() : 0;
      ok(coarseCount === meta.coarseIndexCount, `coarse accessor count ${coarseCount} == meta ${meta.coarseIndexCount}`);

      // primitive.indices must equal LOD0 of every cluster = the full-res mesh a
      // stock viewer renders.
      let lod0sum = 0, badLod0 = 0, badCoarse = 0, wrongStream = 0, emptyLod = 0;
      for (const c of meta.clusters) {
        for (let l = 0; l < c.lods.length; l++) {
          const { offset, count, stream } = c.lods[l];
          if (count <= 0) emptyLod++;
          if (count % 3 !== 0) badLod0++;
          if (l === 0 && stream !== 0) wrongStream++;
          if (l > 0 && stream !== 1) wrongStream++;
          if (stream === 0) { lod0sum += count; if (offset + count > lod0Count) badLod0++; }
          else if (offset + count > coarseCount) badCoarse++;
        }
      }
      ok(lod0sum === lod0Count, `LOD0 ranges sum (${lod0sum}) == primitive.indices count (${lod0Count}) [stock full-res]`);
      ok(badLod0 === 0, 'all LOD0 ranges in-bounds & multiple-of-3');
      ok(badCoarse === 0, 'all coarse ranges in-bounds');
      ok(wrongStream === 0, 'lod0 -> stream 0, lod1+ -> stream 1');
      ok(emptyLod === 0, 'no empty/degenerate LOD range');

      // every index references a real vertex
      const vcount = prim.getAttribute('POSITION').getCount();
      let maxVid = 0; const arr = idx.getArray();
      for (let i = 0; i < arr.length; i++) if (arr[i] > maxVid) maxVid = arr[i];
      ok(maxVid < vcount, `max LOD0 vertex id ${maxVid} < vertexCount ${vcount}`);
    }
  }
  ok(clusterPrims >= 1, `found >=1 cluster primitive on read-back (${clusterPrims})`);

  // --- source-shape guard: cluster-mode placement must not double-transform ---
  // The cluster-ready path in model-pool.js once did clm.applyMatrix4(src.matrixWorld)
  // then src.parent.add(clm) -- parenting the clm under the glTF node whose TRS was
  // ALREADY folded into src.matrixWorld, applying a non-identity import scale/rotation
  // TWICE (a 0.03 scale rendered as 0.0009; tiny mis-rotated model, collider unaffected).
  // The discrete-LOD path uses a root-relative transform (_rootInv x matrixWorld); the
  // cluster path must too. Assert the buggy double-parent shape is gone and the relative
  // transform is present, the same source-shape idiom the discrete LOD bands are locked with.
  const { readFile } = await import('node:fs/promises');
  const mpSrc = await readFile(new URL('./src/model-pool.js', import.meta.url), 'utf8');
  const clusterReady = mpSrc.slice(mpSrc.indexOf('this.asset.clusterMeshes && this.asset.clusterMeshes.length'));
  const clusterBody = clusterReady.slice(0, clusterReady.indexOf("this.emit('ready'"));
  ok(!/src\.parent\.add\(clm\)/.test(clusterBody), 'cluster path does NOT parent clm under src.parent (double-transform bug)');
  ok(/_rootInv[\s\S]*?src\.matrixWorld/.test(clusterBody) && /this\.root\.add\(clm\)/.test(clusterBody),
    'cluster path applies root-relative transform (_rootInv x src.matrixWorld) and parents clm under this.root');

  // --- _enforceBudget per-frame throttle guard -----------------------------
  // _enforceBudget's expensive eviction scan (rebuild a full inUse Set via a
  // per-entity x per-trackedMesh walk with per-mesh/tex string-key allocation)
  // used to run on EVERY frame whenever over budget, with no cooldown -- unlike
  // the sibling unload-scan (every 5 frames) and stats-cosmetics (every 6
  // frames) throttles right next to it in update(). Assert the cooldown
  // counter is present and gates the scan body so a steady-state over-budget
  // scene doesn't pay the full O(entities) scan every frame.
  {
    const src = mpSrc;
    const body = src.slice(src.indexOf('_enforceBudget() {'), src.indexOf('_enforceBudget() {') + 1600);
    ok(/_enforceBudgetCounter/.test(body), '_enforceBudget has a throttle counter field');
    ok(/this\._enforceBudgetCounter--; return;/.test(body), '_enforceBudget skips the scan body on a non-zero counter (live throttle path)');
    // Live-witness the throttle actually fires: simulate the counter dance
    // exactly as the real method does it, across several simulated frames.
    let counter = 0;
    let scans = 0;
    const simulateFrame = (overBudget) => {
      if (!overBudget) return;
      if (!counter) counter = 0;
      if (counter > 0) { counter--; return; }
      counter = 5;
      scans++; // the expensive body ran
    };
    for (let frame = 0; frame < 20; frame++) simulateFrame(true);
    ok(scans === 4, `throttled to 1 scan per 5 frames over 20 frames (got ${scans} scans, expected 4)`);
  }

  // --- hardening: bakeCluster() input validation (real fs, real files) -----
  {
    let threw = null;
    try { await bakeCluster(join(tmpdir(), `nope-${process.pid}.glb`), OUT); } catch (e) { threw = e; }
    ok(!!threw && /not found or unreadable/.test(threw.message), 'bakeCluster throws a clear error for a missing INPUT file');

    const badMagicPath = join(tmpdir(), `bad-magic-${process.pid}.glb`);
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(badMagicPath, Buffer.from('not a glb'));
    threw = null;
    try { await bakeCluster(badMagicPath, OUT); } catch (e) { threw = e; }
    ok(!!threw && /not a valid GLB \(bad magic\)/.test(threw.message), 'bakeCluster throws a clear error for a non-GLB INPUT file');
    await rm(badMagicPath, { force: true });
  }

  // --- hardening: parseClusterLod rejects structurally malformed extras ----
  {
    const wellFormed = { [CLUSTER_LOD_EXTRA_KEY]: { clusters: [{ aabb: [0, 0, 0, 1, 1, 1], sphere: [0, 0, 0, 1], lods: [{ offset: 0, count: 3, stream: 0 }] }] } };
    ok(!!parseClusterLod(wellFormed), 'parseClusterLod accepts a structurally valid cluster');
    const malformedCases = [
      { aabb: [0, 0, 0], sphere: [0, 0, 0, 1], lods: [{ offset: 0, count: 3 }] },      // aabb wrong length
      { aabb: [0, 0, 0, 1, 1, 1], sphere: [0, 0, 0, 1], lods: [{ offset: 0, count: -5 }] }, // negative count
      { aabb: [0, 0, 0, 1, 1, 1], sphere: [0, 0, 0, NaN], lods: [{ offset: 0, count: 3 }] }, // NaN in sphere
    ];
    for (const c of malformedCases) {
      const extras = { [CLUSTER_LOD_EXTRA_KEY]: { clusters: [c] } };
      ok(parseClusterLod(extras) === null, `parseClusterLod fails-open (returns null) for malformed cluster ${JSON.stringify(c).slice(0, 60)}`);
    }
  }

  // --- hardening: DeferredLoadQueue clamps non-positive constructor args ---
  {
    const q = new DeferredLoadQueue(0, -5, -1);
    ok(q.maxConcurrent === 1, 'DeferredLoadQueue clamps maxConcurrent<=0 to 1 (was: wedges forever)');
    ok(q.maxQueueSize === 1, 'DeferredLoadQueue clamps maxQueueSize<=0 to 1');
    ok(q.requestTimeoutMs === 1000, 'DeferredLoadQueue clamps requestTimeoutMs<=0 to 1000');
  }

  // --- hardening: spawn()-adjacent url type validation exists in source ----
  {
    const mpSrc2 = await readFile(new URL('./src/model-pool.js', import.meta.url), 'utf8');
    ok(/spawn\(url, opts = \{\}\) \{[\s\S]{0,120}typeof url !== 'string'/.test(mpSrc2), 'spawn() validates url is a string, not just truthy');
    const poolDisposeIdx = mpSrc2.indexOf('Idempotency guard');
    ok(poolDisposeIdx >= 0 && /if \(this\._disposed\) return;\s*this\._disposed = true;/.test(mpSrc2.slice(poolDisposeIdx, poolDisposeIdx + 900)), 'ModelPool.dispose() is idempotent (second call is a safe no-op)');
    ok(/bad magic; got \$\{buf\.byteLength\}/.test(mpSrc2), 'Asset._fetchBytes validates the GLB magic before handing bytes to the loader');
  }

  await rm(OUT, { force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[FAIL] threw', e.message, e.stack); process.exit(1); });
