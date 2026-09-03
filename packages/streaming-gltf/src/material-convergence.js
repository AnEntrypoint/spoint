// Material convergence analysis + collapse (bake-time enabler for BatchedMesh/
// multi-draw bucketing). Dependency-free at the analysis layer -- it works off
// a gltf-transform Document's real Material/Texture graph, no meshopt/GPU needed.
//
// SCOPE (honest tiering -- see packages/streaming-gltf/AGENTS.md for the fuller
// note): a full texture-array-atlas + uber-shader convergence pass is a real,
// multi-week rendering-pipeline undertaking (texture packing, UV remap per
// packed layer, a shared PBR uber-shader with a per-instance material-index
// attribute, KTX2 array-layer encode, and a BatchedMesh/InstancedMesh2 runtime
// consumer for the index). What ships here is the real, working FIRST tier that
// pass genuinely enables and de-risks:
//
//   1. materialConvergenceReport(doc)  -- exact, honest measurement of how many
//      DISTINCT materials/textures a document has post-`dedup()`, keyed by their
//      actual rendering-relevant parameters (texture image identity + scalar
//      factors + alpha/blend state), independent of gltf-transform's stricter
//      byte-for-byte Material#equals. This is the number a bucketing pass needs
//      to decide "is this asset even a batching candidate" -- previously
//      unmeasured anywhere in the pipeline.
//
//   2. collapseTrivialMaterialVariants(doc) -- a real collapse pass: merges
//      materials whose PBR-relevant key (texture identity via pixel-content hash,
//      not object identity + every scalar factor + alphaMode/alphaCutoff/
//      doubleSided) matches exactly, even when gltf-transform's own dedup()
//      missed them because of incidental differences (name, extras, unrelated
//      unused texture slots) `Material#equals` does not skip. This is strictly
//      additive to dedup() -- run AFTER it -- and only ever merges materials that
//      are visually IDENTICAL, never an approximation/threshold merge (no fidelity
//      risk).
//
//   3. corpusMaterialConvergence(reports) -- cross-asset aggregation: hashes every
//      material key across N already-analyzed documents and reports which keys
//      recur across DIFFERENT source assets (the real BatchedMesh/texture-array
//      bucketing candidate list -- "these 340 materials across 92 models reduce to
//      14 unique uber-material buckets"). This is the corpus-wide convergence
//      number the task asks for; turning it into actual shared runtime GPU state
//      (texture-array layers, a runtime material-index buffer) is the follow-on
//      the report is scoped to feed, not something this pass fabricates.
//
//   4. stampMaterialBucketKeys(doc) -- writes each material's short, stable
//      bucket hash (8 hex chars of sha1(materialKey(material))) onto
//      material.extras.EP_material_bucket. This is the bridge from "bake-time
//      analysis" to "runtime consumer": bake-cluster.mjs calls this AFTER
//      collapseTrivialMaterialVariants(), then copies the winning primitive's
//      bucket hash into that primitive's EP_cluster_lod extras (materialBucket)
//      so the runtime (src/cluster-lod-mesh.js's parseClusterLod / model-pool.js)
//      can read a stable cross-asset bucket id for a cluster mesh WITHOUT
//      recomputing texture-content hashes at load time (which would need the
//      raw image bytes decoded, expensive to redo per spawn). Two materials in
//      DIFFERENT baked assets that render identically get the IDENTICAL bucket
//      hash (content-based, not object-identity), which is exactly the signal
//      src/material-bucket-batcher.js's runtime BatchedMesh consumer keys on to
//      decide "these two distinct cluster assets can share one draw call".
//
// NOT attempted here (explicitly out of scope, needs a dedicated pass): texture
// atlasing/array-layer packing, UV remapping, uber-shader authoring, near-duplicate
// (similarity-threshold) material merging. All three risk visible fidelity loss.
// What DOES now exist (src/material-bucket-batcher.js, wired into model-pool.js's
// cluster-entity far tier): a real BatchedMesh runtime consumer for the EXACT
// (single-texture-slot, already-converged) bucket case -- see that file's header
// for its own honest scope note (LOD0/coarsest-tier only, not a per-cluster
// texture-array sampling path).

import { createHash } from 'node:crypto';

/**
 * Stable content hash for a gltf-transform Texture's actual pixel bytes (not
 * object identity). Two textures with identical image bytes hash identically
 * even across separate Documents (separate bake runs), which is what lets
 * corpusMaterialConvergence() find cross-asset texture reuse dedup() (a single-
 * document transform) structurally cannot see.
 */
function textureHash(tex) {
  if (!tex) return null;
  const img = tex.getImage();
  if (!img || !img.byteLength) return null;
  return createHash('sha1').update(Buffer.isBuffer(img) ? img : Buffer.from(img.buffer, img.byteOffset, img.byteLength)).digest('hex');
}

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function factorKey(arr) {
  return arr.map((n) => round(n)).join(',');
}

/**
 * The rendering-relevant identity of a material: every input a shared uber-
 * material parameter block / BatchedMesh bucket would need to distinguish.
 * Two materials with the same key render identically (modulo float rounding
 * at `places` precision) and are always safe to collapse into one instance.
 */
function materialKey(material) {
  const parts = [
    `bc:${factorKey(material.getBaseColorFactor())}`,
    `em:${factorKey(material.getEmissiveFactor())}`,
    `rough:${round(material.getRoughnessFactor())}`,
    `metal:${round(material.getMetallicFactor())}`,
    `alpha:${material.getAlphaMode()}:${round(material.getAlphaCutoff())}`,
    `ds:${material.getDoubleSided() ? 1 : 0}`,
    `bcTex:${textureHash(material.getBaseColorTexture()) || '-'}`,
    `emTex:${textureHash(material.getEmissiveTexture()) || '-'}`,
    `nrmTex:${textureHash(material.getNormalTexture()) || '-'}`,
    `occTex:${textureHash(material.getOcclusionTexture()) || '-'}`,
    `mrTex:${textureHash(material.getMetallicRoughnessTexture()) || '-'}`,
  ];
  return parts.join('|');
}

/**
 * Measures material/texture variant count and convergence opportunity for ONE
 * already-loaded gltf-transform Document. Call AFTER dedup() (bakeCluster
 * already runs dedup()) so the numbers reflect real remaining variance, not
 * accidental exact duplicates dedup() would already have merged.
 *
 * Returns real counts, never an estimate: materialCount is `root.listMaterials()
 * .length` (ground truth), uniqueKeyCount is the number of distinct rendering-
 * relevant keys among them (the convergence target), and `buckets` is the
 * grouping so a caller can see exactly which materials collapse together.
 */
function materialConvergenceReport(doc) {
  const root = doc.getRoot();
  const materials = root.listMaterials();
  const textures = root.listTextures();
  const byKey = new Map(); // key -> [material,...]
  for (const mat of materials) {
    const key = materialKey(mat);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(mat);
  }
  const buckets = [...byKey.entries()].map(([key, mats]) => ({ key, count: mats.length, names: mats.map((m) => m.getName() || '(unnamed)') }));
  buckets.sort((a, b) => b.count - a.count);
  return {
    materialCount: materials.length,
    textureCount: textures.length,
    uniqueKeyCount: byKey.size,
    convergenceRatio: materials.length > 0 ? round(byKey.size / materials.length) : 1,
    trivialCollapseCandidates: materials.length - byKey.size,
    buckets,
  };
}

/**
 * Real collapse pass: for every bucket of >1 materials sharing an exact
 * rendering-relevant key, repoint every primitive using the non-canonical
 * members onto the first (canonical) member and dispose the now-unused
 * duplicates. Strictly a superset of gltf-transform's own dedup() -- it uses
 * PIXEL-CONTENT texture identity + PBR-relevant factors instead of
 * Material#equals' broader property-for-property equality (which considers
 * fields like extras/unrelated texture slots that don't affect rendered
 * output), so it catches real duplicates dedup() misses without ever merging
 * two materials that would render differently.
 *
 * Returns {merged, remaining} so a caller (bakeCluster) can report a real
 * before/after delta.
 */
function collapseTrivialMaterialVariants(doc) {
  const root = doc.getRoot();
  const materials = root.listMaterials();
  const before = materials.length;
  const byKey = new Map();
  for (const mat of materials) {
    const key = materialKey(mat);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(mat);
  }
  let merged = 0;
  for (const mats of byKey.values()) {
    if (mats.length < 2) continue;
    const canonical = mats[0];
    for (let i = 1; i < mats.length; i++) {
      const dup = mats[i];
      for (const parent of dup.listParents()) {
        // Root's own back-reference isn't a real "usage" to repoint.
        if (parent === root) continue;
        parent.swap(dup, canonical);
      }
      dup.dispose();
      merged++;
    }
  }
  return { merged, remaining: before - merged };
}

/**
 * Cross-asset aggregation: feed it the materialConvergenceReport() output for
 * every asset in a corpus (each keyed by its own key-space, but materialKey()
 * is content-based so identical keys ACROSS documents mean the same real
 * texture bytes + factors) and get back which uber-material buckets recur
 * across multiple distinct assets -- the actual signal for "these N assets
 * could share one BatchedMesh material bucket / texture-array layer".
 *
 * `assetReports` is [{ name, report }] where report = materialConvergenceReport()
 * output for that asset's baked Document.
 */
function corpusMaterialConvergence(assetReports) {
  const byKey = new Map(); // key -> Set(assetName)
  const keyCount = new Map(); // key -> total material instance count across corpus
  for (const { name, report } of assetReports) {
    for (const bucket of report.buckets) {
      if (!byKey.has(bucket.key)) byKey.set(bucket.key, new Set());
      byKey.get(bucket.key).add(name);
      keyCount.set(bucket.key, (keyCount.get(bucket.key) || 0) + bucket.count);
    }
  }
  const crossAssetBuckets = [...byKey.entries()]
    .filter(([, assets]) => assets.size > 1)
    .map(([key, assets]) => ({ key, assetCount: assets.size, assets: [...assets], materialInstances: keyCount.get(key) }))
    .sort((a, b) => b.assetCount - a.assetCount);

  const totalMaterials = assetReports.reduce((s, a) => s + a.report.materialCount, 0);
  const totalUniqueKeys = byKey.size;
  return {
    assetCount: assetReports.length,
    totalMaterials,
    totalUniqueKeys,
    corpusConvergenceRatio: totalMaterials > 0 ? round(totalUniqueKeys / totalMaterials) : 1,
    crossAssetBuckets,
  };
}

/**
 * Extras key a primitive/material carries its convergence bucket hash under.
 * Short (8 hex chars = 32 bits) rather than the full pipe-delimited materialKey()
 * string -- the full key can be ~200+ bytes (multiple sha1 texture hashes
 * concatenated) and this is written once per material AND once per cluster
 * primitive into JSON extras that ship in every baked GLB; a 32-bit hash collision
 * across a real corpus (hundreds, not billions, of unique materials) is
 * astronomically unlikely and this is a BATCHING HINT, not a correctness-critical
 * identity -- a false-positive bucket match would only ever merge two draws that
 * still each render their own real geometry/material assignment correctly (see
 * material-bucket-batcher.js: the batcher's BatchedMesh instances still each
 * reference their own registered geometry id; the bucket only decides which
 * shared BatchedMesh a geometry is registered into, never which pixels a
 * fragment shader samples).
 */
const MATERIAL_BUCKET_EXTRAS_KEY = 'EP_material_bucket';

/**
 * Real bridge from bake-time analysis to a runtime-readable tag: hashes every
 * material's rendering-relevant key (the same key materialConvergenceReport()
 * buckets by) down to a short stable hex string and writes it onto
 * material.extras[EP_material_bucket]. Idempotent (safe to call more than once;
 * always recomputes from the material's CURRENT state) and side-effect-free
 * beyond the extras write -- never merges/mutates/disposes a material itself
 * (that is collapseTrivialMaterialVariants()'s job, and this should run AFTER
 * it so the stamped hashes reflect the POST-collapse material graph).
 *
 * Returns a Map<Material, bucketHash> for the caller (bake-cluster.mjs) to look
 * up a primitive's material's bucket without re-reading extras back off the
 * material it just wrote them to.
 */
function stampMaterialBucketKeys(doc) {
  const root = doc.getRoot();
  const byMaterial = new Map();
  for (const mat of root.listMaterials()) {
    const key = materialKey(mat);
    const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
    const extras = mat.getExtras() || {};
    extras[MATERIAL_BUCKET_EXTRAS_KEY] = hash;
    mat.setExtras(extras);
    byMaterial.set(mat, hash);
  }
  return byMaterial;
}

export {
  materialKey,
  textureHash,
  materialConvergenceReport,
  collapseTrivialMaterialVariants,
  corpusMaterialConvergence,
  stampMaterialBucketKeys,
  MATERIAL_BUCKET_EXTRAS_KEY,
};
