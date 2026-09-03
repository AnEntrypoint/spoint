#!/usr/bin/env node
// Batch cluster-LOD baker for the ../assets corpus.
//
// Walks manifest.json, bakes each source GLB into the single-file cluster-LOD
// format under <assets>/streaming-cluster/<name>.cluster.glb, and writes
// manifest.cluster.json mapping source path -> baked cluster GLB. Skinned/morph
// prims inside an asset are left untouched by the baker (see bake-cluster.mjs).
//
// Each asset is baked in this single node process (heavy clustering must NOT run
// via the exec_js verb). For the full 1868-asset corpus this is a long run; use
//   LIMIT=N      bake only the first N assets (witness / smoke)
//   CATEGORY=X   bake only category X
//   CONCURRENCY  (default 1) sequential is safest for memory.
//
//   node tools/bake-cluster-corpus.mjs [assetsDir]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { bakeCluster } from './bake-cluster.mjs';
import { corpusMaterialConvergence } from '../src/material-convergence.js';

const ASSETS = process.argv[2] || '../assets';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const ONLY_CAT = process.env.CATEGORY || null;
const OUT_SUBDIR = 'streaming-cluster';

async function main() {
  const manifest = JSON.parse(await readFile(join(ASSETS, 'manifest.json'), 'utf8'));
  const outDir = join(ASSETS, OUT_SUBDIR);
  await mkdir(outDir, { recursive: true });

  const out = {}; // category -> [{name, path, cluster}]
  let done = 0, failed = 0, totalClusters = 0;
  const failures = [];
  const materialReports = []; // {name, report} across the whole run, for corpus-wide convergence

  for (const [cat, items] of Object.entries(manifest)) {
    if (ONLY_CAT && cat !== ONLY_CAT) continue;
    out[cat] = [];
    for (const item of items) {
      if (done >= LIMIT) break;
      const src = join(ASSETS, item.path);
      const clusterRel = join(OUT_SUBDIR, item.path.replace(/[\\/]/g, '__').replace(/\.glb$/i, '.cluster.glb'));
      const dst = join(ASSETS, clusterRel);
      await mkdir(dirname(dst), { recursive: true });
      try {
        const r = await bakeCluster(src, dst);
        totalClusters += r.totalClusters;
        out[cat].push({ name: item.name, path: item.path, cluster: clusterRel.replace(/\\/g, '/'), clusters: r.totalClusters });
        if (r.materialReport) materialReports.push({ name: item.path, report: r.materialReport });
        done++;
      } catch (e) {
        failed++;
        failures.push({ path: item.path, error: e.message });
        console.error(`[corpus] FAIL ${item.path}: ${e.message}`);
      }
    }
    if (done >= LIMIT) break;
  }

  await writeFile(join(ASSETS, 'manifest.cluster.json'), JSON.stringify(out, null, 1));
  console.log(`\n[corpus] baked ${done} assets, ${totalClusters} clusters total, ${failed} failed.`);
  if (failures.length) console.log('[corpus] failures:', JSON.stringify(failures.slice(0, 20), null, 1));
  console.log(`[corpus] manifest -> ${join(ASSETS, 'manifest.cluster.json')}`);

  // Cross-asset material convergence report (the real corpus-wide batching signal:
  // which uber-material buckets recur across DIFFERENT source assets). See
  // src/material-convergence.js for the full method + scope note.
  if (materialReports.length) {
    const convergence = corpusMaterialConvergence(materialReports);
    const convergencePath = join(ASSETS, 'manifest.material-convergence.json');
    await writeFile(convergencePath, JSON.stringify(convergence, null, 1));
    console.log(`[corpus] material convergence: ${convergence.totalMaterials} materials across ${convergence.assetCount} assets -> ${convergence.totalUniqueKeys} unique uber-material buckets (ratio ${convergence.corpusConvergenceRatio}), ${convergence.crossAssetBuckets.length} bucket(s) shared across >1 asset`);
    console.log(`[corpus] material convergence report -> ${convergencePath}`);
  }
}

main().catch((e) => { console.error('[corpus] fatal', e.message, e.stack); process.exit(1); });
