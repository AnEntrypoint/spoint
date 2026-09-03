#!/usr/bin/env node
// Cluster-LOD baker (EP_cluster_lod).
//
// Reads a GLB and, for each UNSKINNED static primitive, rebuilds it as a single
// unified vertex+index buffer of UV-aware spatial meshlet clusters with per-cluster
// hierarchical LODs (see examples/local-progressive/meshlet-codec.js). Per-cluster
// AABB/sphere + per-(cluster,lod) index {offset,count} are written into
// primitive.extras.EP_cluster_lod (JSON only). The geometry stays a STANDARD single
// mesh/primitive: a stock glTF viewer ignores the extras and draws the whole index
// buffer = LOD0 of every cluster = the full-resolution mesh. EXT_meshopt_compression
// keeps the GLB small and valid.
//
// Skinned/morph primitives are left untouched (cluster-LOD is for static geometry;
// the runtime keeps its existing path for those).
//
// Run as a SEPARATE node process (heavy clustering OOMs an in-process host):
//   node tools/bake-cluster.mjs <input.glb> <output.glb>

import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, simplify, cloneDocument } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3dgltf from 'draco3dgltf';
import { buildClusterLod, buildClusterLodExtra, CLUSTER_LOD_EXTRA_KEY } from '../src/meshlet-codec.js';
import { materialConvergenceReport, collapseTrivialMaterialVariants, stampMaterialBucketKeys } from '../src/material-convergence.js';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Discrete-LOD ratios for SKINNED/morph primitives (cluster-LOD cannot handle them
// -- it needs static topology). meshopt simplify() preserves JOINTS_0/WEIGHTS_0 +
// morph deltas (the simplified index is a subset of original vertices), so a skinned
// VRM gets real LOD scaling. Lowest detail first matches the runtime sort (ascending
// quality). 1.0 is the inline base in the root; the rest are sibling files.
const SKINNED_LOD_RATIOS = [1.0, 0.4, 0.15];
const EP_PROGRESSIVE_LOD_KEY = 'EP_progressive_lod';

// Map a gltf-transform primitive's accessors to the meshlet-codec geo shape.
// Attribute names are lowercased ('POSITION'->'position', 'TEXCOORD_0'->'texcoord_0')
// to match the codec's expectations; the codec keys position/uv off those names.
const ATTR_RENAME = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', TEXCOORD_0: 'texcoord_0', COLOR_0: 'color' };

function primIsStatic(prim) {
  if (prim.getAttribute('JOINTS_0') || prim.getAttribute('WEIGHTS_0')) return false;
  if (prim.listTargets && prim.listTargets().length) return false;
  return true;
}

function primToGeo(prim) {
  const semantics = prim.listSemantics();
  const attributes = [];
  for (const sem of semantics) {
    const acc = prim.getAttribute(sem);
    if (!acc) continue;
    const name = ATTR_RENAME[sem] || sem.toLowerCase();
    attributes.push({ name, itemSize: acc.getElementSize(), normalized: acc.getNormalized(), array: acc.getArray(), _sem: sem });
  }
  const idxAcc = prim.getIndices();
  const index = idxAcc ? _dropDegenerateTriangles(idxAcc.getArray(), attributes) : null;
  return { attributes, index, _semByName: Object.fromEntries(attributes.map((a) => [a.name, a._sem])) };
}

// Drops zero-area triangles (two or more vertex INDICES resolving to coincident
// POSITIONS -- distinct from a repeated-index check, which misses this class
// entirely) before clustering ever sees them. Source models can carry these from
// an export/weld step that left duplicate-position vertices under separate
// indices (observed live: aim_sillos.glb mesh 16, indices [1571,1572,1573],
// vertex 1571 and 1573 at the identical world position, a zero-area sliver that
// renders as a long degenerate triangle radiating from the shared point at
// runtime). MeshoptClusterizer has no such filter of its own, so a defect like
// this survives unchanged into every downstream cluster/LOD.
// Post-cluster degenerate-triangle pass, on buildClusterLod's own reordered
// output. Unlike _dropDegenerateTriangles (which can safely shrink the index
// array pre-cluster, since nothing downstream references byte offsets into it
// yet), removing an index here would shift every later cluster's lods[].offset
// out from under it -- so a degenerate triangle is COLLAPSED in place (all 3
// indices set to the first) rather than removed, keeping every array length
// and every cluster's recorded offset/count exactly unchanged. A collapsed
// triangle has zero area everywhere and costs one wasted GPU vertex-fetch, not
// a visible sliver.
// A zero-length edge (coincident vertices) is one cause of a degenerate
// triangle, but NOT the only one: three DISTINCT, well-separated vertices
// that happen to be collinear also produce a zero-area sliver, and an
// edge-length-only check structurally cannot see it (every edge can be
// arbitrarily long while the cross product -- and therefore the area --
// is exactly zero). Live-witnessed on aim_sillos.glb: of 88311 degenerate
// triangles found by a real triangle-area scan, only ~17000 also failed an
// edge-length<1e-6 test; the remaining ~71000 were exact-zero-area
// collinear triangles with every edge length well above that threshold,
// meaning the two prior edge-length-based filters below passed nearly all
// of them straight through into the shipped asset. AREA is the actual
// invariant a renderer/clusterizer cares about, so both filters below now
// compute it directly via the cross-product magnitude instead of using
// edge length as a proxy for it.
//
// EPS_AREA=1e-4 (m^2), raised from an earlier 1e-6: that tighter value was still measured too tight on
// this same asset -- a real (physics-loader-side) area scan post-fix found 26 defective triangles
// surviving at 1e-6, all genuine thin/near-collinear slivers, none fixable by vertex welding (tested live
// at 0.1mm-10mm cell sizes) or by meshoptimizer's simplifyPrune/simplify (tested live, neither removes
// them -- they target topological/error metrics, not sub-visual absolute area). The real per-triangle
// area distribution on this mesh has a clean, non-arbitrary gap: every defective triangle measures
// <=7.26e-5 m^2, the next-smallest LEGITIMATE triangle measures 1.12e-4 m^2 (a ~50% gap, zero triangles in
// between) -- 1e-4 sits inside that gap, catching every real defect while cutting zero real geometry. This
// is not a tuning knob to nudge again on the next report -- if a future asset needs a different value,
// re-run the same live area-histogram check (sort all triangle areas, find the real gap) rather than
// picking a rounder number. See AGENTS.md project/degenerate-triangle-threshold-is-not-a-tunable-guess and
// its sibling fix in src/physics/ShapeBuilder.js (the physics-loader path, which reads this same source
// GLB directly and needs the identical threshold).
function _triArea(pos, a, b, c) {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
  const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const cxp = uy * vz - uz * vy, cyp = uz * vx - ux * vz, czp = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cxp, cyp, czp);
}

// Fan-triangle defect (distinct from the zero-area EPS_AREA class below): a real,
// live-witnessed defect on aim_sillos.glb -- window.__scene direct raycast + vertex-
// usage histogram found 4 vertices used in 6711/3525/3487/3151 triangles each (median
// vertex usage across the mesh: 2; p99: 13), each one the shared apex of a huge fan of
// long, thin, real-area (NOT caught by EPS_AREA) sliver triangles reaching clear
// across the map. Tightening buildClusterLod's lodError (0.05->0.02) had ZERO effect
// on the count (2268 before and after a real re-bake), ruling out simplification-
// quality as the cause -- the fan vertices are established by MeshoptClusterizer's own
// per-cluster vertex/index construction (buildMeshletsSpatial + the local->global
// remap in meshlet-codec.js), not the simplify() pass. No clean global usage-count
// threshold exists to cut on (smooth tail below the top ~9 outliers) -- but each
// cluster's own AABB diagonal IS a real, structural bound: a genuine cluster-LOD
// triangle can never legitimately span further than its own cluster's bounding box
// (clusters are spatially coherent meshlets by construction, maxVertices=64), so ANY
// triangle edge exceeding that cluster's AABB diagonal by a wide safety margin is
// definitionally wrong, regardless of area or vertex-usage-count. Collapsed the same
// way as an EPS_AREA hit (all 3 indices -> the first) so downstream offset/count
// tables are unaffected.
function _collapseFanTriangles(result, meshIndex, primIndex) {
  const posAttr = result.attributes.find((a) => a.name === 'position');
  if (!posAttr) return;
  const pos = posAttr.array;
  let fixed = 0;
  for (const cluster of result.clusters) {
    const [mnx, mny, mnz, mxx, mxy, mxz] = cluster.aabb;
    const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
    // 3x the cluster's own diagonal: comfortably above any legitimate intra-cluster
    // edge (which cannot exceed the diagonal itself), tight enough to catch a fan
    // edge that reaches clear across the mesh from one cluster's vertex.
    const maxLegitEdgeSq = (diag * 3) * (diag * 3);
    for (const lod of cluster.lods) {
      const idx = lod.stream === 1 ? result.indexCoarse : result.index;
      const start = lod.offset, end = lod.offset + lod.count;
      for (let i = start; i + 2 < end; i += 3) {
        const a = idx[i], b = idx[i + 1], c = idx[i + 2];
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
        const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
        const e1Sq = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
        const e2Sq = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2;
        const e3Sq = (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2;
        if (e1Sq > maxLegitEdgeSq || e2Sq > maxLegitEdgeSq || e3Sq > maxLegitEdgeSq) {
          idx[i + 1] = a; idx[i + 2] = a; fixed++;
        }
      }
    }
  }
  if (fixed) console.warn(`[bake-cluster] collapsed ${fixed} fan (out-of-cluster-bounds) triangle(s) (mesh ${meshIndex} prim ${primIndex})`);
}

function _checkClusterLodResultForDegenerates(result, meshIndex, primIndex) {
  const posAttr = result.attributes.find((a) => a.name === 'position');
  if (!posAttr) return;
  const pos = posAttr.array;
  const EPS_AREA = 1e-4;
  let fixed = 0;
  const scan = (idx) => {
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (_triArea(pos, a, b, c) < EPS_AREA) { idx[i + 1] = a; idx[i + 2] = a; fixed++; }
    }
  };
  scan(result.index);
  scan(result.indexCoarse);
  if (fixed) console.warn(`[bake-cluster] collapsed ${fixed} post-cluster degenerate (zero-area) triangle(s) (mesh ${meshIndex} prim ${primIndex})`);
  _collapseFanTriangles(result, meshIndex, primIndex);
}

function _dropDegenerateTriangles(index, attributes) {
  const posAttr = attributes.find((a) => a.name === 'position');
  if (!posAttr) return index;
  const pos = posAttr.array;
  const EPS_AREA = 1e-4;
  const out = [];
  let dropped = 0;
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    if (_triArea(pos, a, b, c) < EPS_AREA) { dropped++; continue; }
    out.push(a, b, c);
  }
  if (dropped) console.warn(`[bake-cluster] dropped ${dropped} degenerate (zero-area) triangle(s) before clustering`);
  return dropped ? new index.constructor(out) : index;
}

// Build discrete LOD siblings for ONE skinned primitive. Clones the document down
// to just this primitive, meshopt-simplifies it per ratio (preserving skin attrs +
// morphs), and writes each LOD<1.0 as a standalone sibling GLB under <outDir>/lods/.
// Returns { meshIndex, primIndex, lods:[...] } for the EP_progressive_lod payload,
// where exactly one entry (ratio 1.0) is inline:true (drawn from the root). The
// runtime (model-pool.js _applyLod skinned branch) swaps the sibling geometry onto
// the root's shared skeleton, so the sibling needs no skeleton of its own -- only
// JOINTS_0/WEIGHTS_0 that index the same joints, which simplify() preserves.
async function _bakeSkinnedLods(srcDoc, io, meshIndex, primIndex, lodsDir, baseName) {
  const lods = [];
  for (const ratio of SKINNED_LOD_RATIOS) {
    if (ratio >= 1.0) { lods.push({ ratio: 1.0, kind: 'textured', inline: true }); continue; }
    // Fresh clone per ratio so each simplify starts from the full-res source
    // (simplify is destructive; chaining ratios would compound error). Cloned
    // in-memory from the already-parsed source document instead of re-reading
    // + re-parsing the GLB off disk for every ratio (was 3x redundant I/O+parse
    // per skinned primitive; cloneDocument gives an equally-fresh independent
    // Document via gltf-transform's own deep merge).
    const doc = cloneDocument(srcDoc);
    const root = doc.getRoot();
    const meshes = root.listMeshes();
    const mesh = meshes[meshIndex];
    if (!mesh) break;
    const prims = mesh.listPrimitives();
    const keepPrim = prims[primIndex];
    if (!keepPrim) break;
    // Strip every OTHER mesh + every other primitive so the sibling is geometry-only,
    // single-primitive (the worker takes the first mesh it finds).
    for (const m of meshes) {
      for (const p of m.listPrimitives()) { if (p !== keepPrim) m.removePrimitive(p); }
      if (m !== mesh) m.dispose();
    }
    const pos = keepPrim.getAttribute('POSITION');
    if (!pos) break;
    // decodeAABB = POSITION min/max BEFORE meshopt quantization (the worker rescales
    // the decoded [-1,1]-ish positions back into character-local space with this).
    const min = pos.getMinNormalized ? pos.getMin([]) : pos.getMin([]);
    const max = pos.getMax([]);
    const decodeAABB = { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
    try {
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }));
    } catch (e) { continue; }
    const idxAcc = keepPrim.getIndices();
    const vCount = keepPrim.getAttribute('POSITION')?.getCount() || 0;
    const iCount = idxAcc ? idxAcc.getCount() : 0;
    if (iCount === 0 || vCount === 0) continue;   // simplified to a hole -> skip
    // meshopt-encode the sibling at write time.
    doc.createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    const bin = await io.writeBinary(doc);
    const fileName = `${baseName}_m${meshIndex}_p${primIndex}_r${String(ratio).replace('.', '')}.glb`;
    await mkdir(lodsDir, { recursive: true });
    await writeFile(join(lodsDir, fileName), Buffer.from(bin));
    lods.push({ ratio, kind: 'textured', path: `lods/${fileName}`, inline: false, indexCount: iCount, vertexCount: vCount, bytes: bin.byteLength, decodeAABB });
  }
  // Only worth a descriptor if at least one real sibling LOD was emitted.
  const siblingCount = lods.filter((l) => !l.inline).length;
  if (siblingCount === 0) return null;
  return { meshIndex, primIndex, lods };
}

// Pre-flight validation of INPUT: a missing file or a file that isn't actually
// a GLB previously fell straight into io.read(INPUT), which throws an opaque
// gltf-transform-internal error with no hint the real problem was "wrong path"
// or "not a GLB" -- surfaces a clear, actionable message instead. The CLI entry
// point already wraps bakeCluster() in a .catch, but that only helps when
// invoked from the command line; a programmatic caller (e.g. bake-cluster-corpus.mjs,
// or a consumer importing { bakeCluster } directly) gets the same opaque error
// without this check.
async function _validateInputGlb(INPUT) {
  let st;
  try {
    st = await stat(INPUT);
  } catch (e) {
    throw new Error(`bakeCluster: INPUT not found or unreadable: ${INPUT} (${e.code || e.message})`);
  }
  if (!st.isFile()) throw new Error(`bakeCluster: INPUT is not a file: ${INPUT}`);
  const fh = await readFile(INPUT);
  if (fh.byteLength < 4 || fh.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`bakeCluster: INPUT is not a valid GLB (bad magic): ${INPUT}`);
  }
}

// A texture with no source AND no extensions is legal-but-undefined glTF 2.0 ("the
// texture is undefined") -- some exporters leave such entries behind with materials
// still referencing them. three.js GLTFLoader tolerates the reference (no map bound),
// but @gltf-transform/core's reader null-derefs on it (setTextureInfo on a null
// textureInfo). deathrun_kosova.glb ships 8 of these. Sanitize before io.readBinary:
// drop the undefined texture entries and every material reference to them (visually
// identical to three's no-map treatment), remapping the surviving indices.
function _stripUndefinedTextures(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const textures = json.textures || [];
  const bare = new Set(textures.map((t, i) => [t, i]).filter(([t]) => t.source === undefined && Object.keys(t.extensions || {}).length === 0).map(([, i]) => i));
  if (bare.size === 0) return glb;
  const remap = new Map();
  const kept = [];
  textures.forEach((t, i) => { if (!bare.has(i)) { remap.set(i, kept.length); kept.push(t); } });
  json.textures = kept;
  const fixRef = (holder, key) => {
    const ref = holder[key];
    if (!ref || typeof ref !== 'object' || typeof ref.index !== 'number') return;
    if (bare.has(ref.index)) delete holder[key];
    else ref.index = remap.get(ref.index);
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k.endsWith('Texture')) fixRef(node, k);
      else walk(v);
    }
  };
  (json.materials || []).forEach(walk);
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const rest = glb.subarray(20 + jsonLen);
  const out = Buffer.alloc(20 + jsonBuf.length + rest.length);
  glb.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  rest.copy(out, 20 + jsonBuf.length);
  return out;
}

async function bakeCluster(INPUT, OUTPUT) {
  await _validateInputGlb(INPUT);
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
    'draco3d.decoder': await draco3dgltf.createDecoderModule(),
    'draco3d.encoder': await draco3dgltf.createEncoderModule(),
  });

  const doc = await io.readBinary(_stripUndefinedTextures(await readFile(INPUT)));
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  // A degenerate/malformed glTF with zero buffers would otherwise let every
  // later `.setBuffer(buffer)` silently attach an accessor to `undefined`,
  // producing a corrupt output GLB instead of a clear upfront failure. Only
  // an actual clustering candidate needs a buffer to write into, so this check
  // fires lazily -- right before the first prim that would need one -- rather
  // than unconditionally (a document with only skinned/skipped prims and no
  // static geometry to cluster never needs to write a new accessor at all).

  let clustered = 0, skipped = 0, totalClusters = 0, skinnedLodded = 0;
  const pendingExtras = []; // { prim, result, coarseAcc } resolved after transforms
  const skinnedDescs = []; // EP_progressive_lod mesh descriptors (skinned discrete LODs)
  const lodsDir = join(dirname(OUTPUT), 'lods');
  const baseName = 'sk';
  const allMeshes = root.listMeshes();
  for (let mi = 0; mi < allMeshes.length; mi++) {
    const mesh = allMeshes[mi];
    const prims = mesh.listPrimitives();
    for (let pi = 0; pi < prims.length; pi++) {
      const prim = prims[pi];
      if (!primIsStatic(prim)) {
        // Skinned/morph: cluster-LOD can't handle it, but we still give it discrete
        // meshopt LODs (sibling GLBs + EP_progressive_lod) so a VRM/skinned model gets
        // real LOD scaling through ModelPool's skinned LOD ladder.
        try {
          const desc = await _bakeSkinnedLods(doc, io, mi, pi, lodsDir, baseName);
          if (desc) { skinnedDescs.push(desc); skinnedLodded++; }
          else skipped++;
        } catch (e) { console.warn(`[bake-cluster] skinned LOD skipped (mesh ${mi} prim ${pi}): ${e.message}`); skipped++; }
        continue;
      }
      const geo = primToGeo(prim);
      if (!geo.attributes.find((a) => a.name === 'position')) { skipped++; continue; }

      // lodError 0.02 (down from meshlet-codec.js's own 0.05 default): tighter simplification quality,
      // kept as a real improvement even though it did NOT fix the fan-triangle defect investigated below
      // (a real live A/B re-bake with this exact value found the identical 2268 sliver-triangle count
      // before and after, ruling out simplification error as that defect's cause -- see
      // _collapseFanTriangles's own comment for the real root cause and fix).
      const result = await buildClusterLod(geo, { maxVertices: 64, maxTriangles: 128, lodRatios: [1, 0.5, 0.25], lodError: 0.02 });
      if (!result.clusters.length) { skipped++; continue; }
      if (!buffer) throw new Error(`bakeCluster: document has a clusterable static primitive (mesh ${mi} prim ${pi}) but no buffer to write the reordered accessors into (root.listBuffers() is empty) -- malformed glTF`);

      // Second degenerate-triangle pass, this time on buildClusterLod's OWN reordered
      // output (result.index/result.attributes), not just the pre-cluster geo the
      // primToGeo-level filter above already covers. Live-witnessed gap: the
      // primToGeo filter correctly drops a source-level coincident-vertex triangle,
      // but MeshoptClusterizer's own vertex append/reorder (buildMeshletsSpatial +
      // the per-cluster newOrder table in meshlet-codec.js) can independently
      // introduce a NEW coincident-vertex triangle in the post-cluster LOD0 stream
      // that the pre-cluster check never sees -- confirmed live (aim_sillos.glb,
      // a distinct defect at post-cluster vertex count 18470, edges [5.24,5.24,0])
      // surviving all the way to the deployed asset even after the source-level fix.
      _checkClusterLodResultForDegenerates(result, mi, pi);

      // Rewrite attributes with the reordered unified arrays.
      for (const outAttr of result.attributes) {
        const sem = geo._semByName[outAttr.name];
        if (!sem) continue;
        const acc = doc
          .createAccessor()
          .setType(_glType(outAttr.itemSize))
          .setArray(outAttr.array)
          .setNormalized(outAttr.normalized)
          .setBuffer(buffer);
        prim.setAttribute(sem, acc);
      }
      // primitive.indices = LOD0 of every cluster = the full-resolution mesh, so
      // a stock glTF viewer that ignores extras draws the full mesh exactly once.
      const idxAcc = doc.createAccessor().setName(`EP_cluster_lod0_m${mi}_p${pi}`).setType('SCALAR').setArray(result.index).setBuffer(buffer);
      prim.setIndices(idxAcc);

      // Coarse (LOD1..N) indices live in a sidecar accessor referenced from extras.
      // A stock viewer never draws it; the runtime uses it for distant clusters.
      // gltf-transform's prune() would drop it (extras refs are invisible to the
      // graph), so we attach it to the prim's extension-less extras list and
      // resolve its FINAL accessor index after all transforms renumber accessors.
      let coarseAcc = null;
      if (result.indexCoarse.length) {
        coarseAcc = doc.createAccessor().setName(`EP_cluster_lod_coarse_m${mi}_p${pi}`).setType('SCALAR').setArray(result.indexCoarse).setBuffer(buffer);
      }
      pendingExtras.push({ prim, result, coarseAcc, mi, pi });

      clustered++;
      totalClusters += result.clusters.length;
    }
  }

  // Strip extensions the cluster GLB no longer uses. We re-encoded all geometry
  // with EXT_meshopt_compression, so KHR_draco_mesh_compression is dead; leaving
  // it in extensionsUsed forces stock GLTFLoader to demand a DRACOLoader (which it
  // throws without) even though no accessor is draco-compressed. EXT_texture_webp
  // stays — the textures are still webp.
  for (const ext of root.listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
  }

  // dedup only. We deliberately AVOID the meshopt() transform: it runs reorder()
  // which re-permutes vertex/index buffers for GPU cache locality and would
  // DESTROY the cluster (offset,count) table the whole format depends on. The
  // codec already reordered vertices to index order, so reorder is redundant
  // anyway. We must also NOT prune(): it garbage-collects the coarse-index
  // accessors that only extras references.
  await doc.transform(dedup({ propertyTypes: [PropertyType.MESH, PropertyType.TEXTURE, PropertyType.MATERIAL, PropertyType.SKIN] }));

  // Material convergence (bake-time enabler for BatchedMesh/multi-draw bucketing --
  // see src/material-convergence.js for the full scope note). Two real, working
  // steps: (1) collapse any EXACT rendering-relevant duplicate materials/textures
  // dedup() missed (pixel-content texture hash + PBR factor equality, a strict
  // superset of dedup()'s own stricter Material#equals match -- zero fidelity risk,
  // every merge is a true visual duplicate); (2) measure + report the real post-
  // collapse variant count so a bucketing pass has an honest number to plan against.
  // Texture-array atlasing / uber-shader authoring / near-duplicate threshold merges
  // are NOT attempted here -- out of scope for this pass, see the module header.
  const materialCollapse = collapseTrivialMaterialVariants(doc);
  const materialReport = materialConvergenceReport(doc);
  // Runtime consumer bridge (src/material-bucket-batcher.js): stamp each
  // (post-collapse) material with a short stable content-based bucket hash so
  // the EP_cluster_lod extras written below can carry it per-primitive without
  // the runtime ever needing to re-hash texture bytes at spawn time.
  const materialBuckets = stampMaterialBucketKeys(doc);

  // Compression is applied at WRITE time over all bufferViews (lossless FILTER
  // method = no vertex/index reorder, exact layout preserved), so the cluster
  // offsets stay valid. This keeps the GLB small + valid (EXT_meshopt_compression).
  // TEMP DIAGNOSTIC: disabled via SPOINT_NO_MESHOPT env var to isolate whether
  // client-side EXT_meshopt_compression decoding is the source of a live
  // coincident-vertex degenerate-triangle mismatch between the on-disk bytes
  // (verified clean via gltf-transform) and the browser's decoded geometry.
  if (!process.env.SPOINT_NO_MESHOPT) {
    doc.createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  }

  for (const { prim, result } of pendingExtras) {
    const mat = prim.getMaterial();
    const materialBucket = mat ? materialBuckets.get(mat) || null : null;
    const extras = prim.getExtras() || {};
    extras[CLUSTER_LOD_EXTRA_KEY] = buildClusterLodExtra(result, -1, materialBucket);
    prim.setExtras(extras);
  }

  let bin = await io.writeBinary(doc);
  bin = _fixCoarseIndexEncoding(bin, pendingExtras);

  // Splice the EP_progressive_lod payload (skinned discrete LODs) into the root GLB
  // JSON chunk. gltf-transform drops unknown top-level extensions on write, so we
  // rewrite the JSON chunk by hand. The skinned full-res mesh is already INLINE in
  // the root (we never removed it), so each descriptor's inline:true LOD draws from
  // the root primitive; the sibling LODs live under lods/ and are fetched on demand.
  if (skinnedDescs.length) {
    bin = _spliceProgressiveLod(bin, skinnedDescs);
  }

  await writeFile(OUTPUT, Buffer.from(bin));
  console.log(`[bake-cluster] ${INPUT} -> ${OUTPUT}: clustered ${clustered} prim(s), ${totalClusters} clusters, skinned-lodded ${skinnedLodded} prim(s), skipped ${skipped}, ${(bin.byteLength / 1024).toFixed(1)} KiB, materials ${materialReport.materialCount} (${materialCollapse.merged} trivial-collapsed, convergence ${materialReport.convergenceRatio}), ${pendingExtras.length} cluster prim(s) stamped with a materialBucket`);
  return { clustered, skipped, totalClusters, skinnedLodded, bytes: bin.byteLength, materialReport, materialCollapse };
}

// Rewrite a GLB's JSON chunk to carry extensions.EP_progressive_lod (+ list it in
// extensionsUsed, never extensionsRequired so a stock viewer still draws the inline
// base). The BIN chunk is copied through untouched; only the JSON chunk grows.
function _spliceProgressiveLod(bin, meshes) {
  const u8 = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return bin; // not a GLB
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
  json.extensions = json.extensions || {};
  // textures: [] explicit -- this splice path only ever carries mesh LOD descriptors (no separate
  // progressive texture-LOD data), but the consumer (model-pool.js Asset._load) unconditionally
  // iterates ext.textures; omitting the key crashed every skinned/character bake with
  // "ext.textures is not iterable", aborting Asset._load()'s whole try block (meshLodDescs never
  // populated, trackedMeshes empty, impostor/discrete-LOD machinery dead for the entity).
  json.extensions[EP_PROGRESSIVE_LOD_KEY] = { version: 1, storage: 'sibling-file', meshes, textures: [] };
  const used = new Set(json.extensionsUsed || []);
  used.add(EP_PROGRESSIVE_LOD_KEY);
  json.extensionsUsed = [...used];
  let nj = JSON.stringify(json);
  while (nj.length % 4 !== 0) nj += ' ';
  const jb = new TextEncoder().encode(nj);
  const binChunkStart = 20 + jsonLen;
  const binChunkLen = dv.getUint32(binChunkStart, true);
  const binChunkType = dv.getUint32(binChunkStart + 4, true);
  const binData = u8.subarray(binChunkStart + 8, binChunkStart + 8 + binChunkLen);
  const total = 12 + 8 + jb.length + 8 + binData.length;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, total, true);
  odv.setUint32(12, jb.length, true); odv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  let o = 20 + jb.length;
  odv.setUint32(o, binData.length, true); odv.setUint32(o + 4, binChunkType, true); out.set(binData, o + 8);
  return out;
}

function _glType(n) {
  return n === 1 ? 'SCALAR' : n === 2 ? 'VEC2' : n === 3 ? 'VEC3' : n === 4 ? 'VEC4' : 'SCALAR';
}

function _componentType(ctor) {
  return ctor === Uint16Array ? 5123 : 5125;
}

function _fixCoarseIndexEncoding(bin, pendingExtras) {
  const entries = pendingExtras.filter((e) => e.coarseAcc && e.result.indexCoarse.length);
  if (!entries.length) return bin;

  const u8 = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return bin;
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
  const jsonChunkStart = 20;
  const binChunkStart = jsonChunkStart + jsonLen;
  const binChunkLen = dv.getUint32(binChunkStart, true);
  const binChunkType = dv.getUint32(binChunkStart + 4, true);
  const oldBinData = u8.subarray(binChunkStart + 8, binChunkStart + 8 + binChunkLen);

  const accByName = new Map();
  json.accessors.forEach((a, i) => { if (a.name) accByName.set(a.name, i); });
  const primByLod0Name = new Map();
  (json.meshes || []).forEach((m) => {
    (m.primitives || []).forEach((p) => {
      if (p.indices === undefined) return;
      const accDef = json.accessors[p.indices];
      if (accDef && accDef.name) primByLod0Name.set(accDef.name, p);
    });
  });

  const embeddedBufferIndex = json.buffers.findIndex((b) => !b.uri);
  if (embeddedBufferIndex === -1) throw new Error('bakeCluster: no GLB-embedded buffer (buffer with no uri) found to append coarse index bytes into');

  const extraChunks = [];
  let appendOffset = oldBinData.length;
  for (const { result, mi, pi } of entries) {
    const coarseName = `EP_cluster_lod_coarse_m${mi}_p${pi}`;
    const lod0Name = `EP_cluster_lod0_m${mi}_p${pi}`;
    const accIndex = accByName.get(coarseName);
    const accDef = accIndex !== undefined ? json.accessors[accIndex] : null;
    const primDef = primByLod0Name.get(lod0Name);
    if (!accDef || !primDef) throw new Error(`bakeCluster: could not resolve written coarse accessor/primitive for mesh ${mi} prim ${pi} (accessor "${coarseName}" or primitive with indices "${lod0Name}" not found in written GLB)`);
    const meta = primDef.extras && primDef.extras[CLUSTER_LOD_EXTRA_KEY];
    if (meta) meta.coarseIndexAccessor = accIndex;
    const idx = result.indexCoarse;
    const bytes = new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength);
    const alignedLen = (bytes.byteLength + 3) & ~3;
    const padded = alignedLen === bytes.byteLength ? bytes : (() => {
      const p = new Uint8Array(alignedLen);
      p.set(bytes);
      return p;
    })();
    const bufferViewIndex = json.bufferViews.length;
    json.bufferViews.push({
      buffer: embeddedBufferIndex,
      byteOffset: appendOffset,
      byteLength: bytes.byteLength,
    });
    accDef.bufferView = bufferViewIndex;
    accDef.byteOffset = 0;
    accDef.componentType = _componentType(idx.constructor);
    extraChunks.push(padded);
    appendOffset += padded.byteLength;
  }

  const newBinData = new Uint8Array(appendOffset);
  newBinData.set(oldBinData, 0);
  let o = oldBinData.length;
  for (const chunk of extraChunks) { newBinData.set(chunk, o); o += chunk.byteLength; }
  json.buffers[embeddedBufferIndex].byteLength = newBinData.length;

  let jsonBuf = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  if (pad) {
    const p = new Uint8Array(jsonBuf.length + pad).fill(0x20);
    p.set(jsonBuf);
    jsonBuf = p;
  }

  const total = 12 + 8 + jsonBuf.length + 8 + newBinData.length;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, total, true);
  odv.setUint32(12, jsonBuf.length, true); odv.setUint32(16, 0x4e4f534a, true); out.set(jsonBuf, 20);
  let bo = 20 + jsonBuf.length;
  odv.setUint32(bo, newBinData.length, true); odv.setUint32(bo + 4, binChunkType, true); out.set(newBinData, bo + 8);
  return out;
}

export { bakeCluster };

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bake-cluster.mjs')) {
  const [, , INPUT, OUTPUT] = process.argv;
  if (!INPUT || !OUTPUT) {
    console.error('usage: node tools/bake-cluster.mjs <input.glb> <output.glb>');
    process.exit(1);
  }
  bakeCluster(INPUT, OUTPUT).catch((e) => {
    console.error('[bake-cluster] ERROR', e.message, e.stack);
    process.exit(1);
  });
}
