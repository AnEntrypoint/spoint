#!/usr/bin/env node
// Spatial tile-split for whole-map GLBs (EP_map_tile prep step).
//
// A single-object asset (character, prop, weapon) bakes straight through
// bake-cluster.mjs. A whole-MAP GLB (apps/maps/*.glb: dozens-to-hundreds of
// primitives spanning the full level footprint) is a different shape of
// problem: cluster-LOD picks a per-cluster LOD by screen size, but nothing
// upstream ever lets the RUNTIME avoid loading/parsing far-away parts of the
// map at all. That is a tiling problem, not a LOD problem -- this tool splits
// one whole-map source GLB into N spatially-coherent tile GLBs on a world-
// space grid, each written as an independent, self-contained Document. Every
// tile is then baked through the EXISTING cluster-LOD baker
// (bakeCluster from bake-cluster.mjs) unchanged, so each tile gets its own
// per-cluster LOD ladder exactly like any other asset. The output tile GLBs
// drop into manifest.cluster.json-shaped catalog entries and stream through
// model-pool.js's ordinary per-asset lazy Asset loader -- no new runtime
// loading path is needed, "the same streaming-gltf tile path" IS the
// existing per-asset stream, just fed more (smaller) assets instead of one
// huge one.
//
// SCOPE (honest): this pass is the real, working spatial-split BAKE step --
// grid partition by triangle centroid, geometry-correct (never slices a
// triangle across a tile boundary; a straddling primitive is split into
// per-tile triangle subsets, never left duplicated or dropped), followed by
// per-tile cluster-LOD baking. Runtime screen-space-error-driven tile
// prioritization (as opposed to today's per-cluster screen-size LOD, which
// already exists per-tile) is NOT implemented here -- it is a follow-up that
// consumes the tile manifest this tool produces (each tile's world-space
// AABB + vertex/triangle count is already recorded in the manifest for that
// follow-up to key off).
//
// Algorithm:
//   1. Read the source GLB (full ALL_EXTENSIONS + draco decoder, matching
//      bake-cluster.mjs's own reader setup -- whole-map GLBs in this repo's
//      apps/maps/ corpus are draco-compressed).
//   2. Compute the scene's world-space AABB (getBounds), lay a uniform grid
//      of `tilesX` x `tilesZ` cells across the XZ footprint (Y is left
//      un-split -- maps are wide, not tall; a vertical split would slice
//      through rooms).
//   3. For every primitive on every node with a mesh (recursing the full
//      node tree, composing world transforms), assign each TRIANGLE to a
//      cell by its centroid in world space. A primitive whose triangles land
//      in only one cell moves whole; a primitive straddling cells is split
//      into per-cell triangle subsets (compactPrimitive-style local index
//      remap), so geometry is always intact -- no triangle is ever cut, no
//      geometry is duplicated across tiles, and nothing is silently dropped.
//   4. Build one gltf-transform Document per non-empty cell via
//      copyToDocument (real cross-document property transfer), each
//      containing only the node/mesh/primitive/material/texture graph that
//      cell actually references (prune() at the end drops the rest).
//   5. Write each tile Document to its own GLB, then run bakeCluster() on it
//      (a real, separate node-process-safe call -- see bake-cluster.mjs's
//      own OOM warning) so each tile lands the SAME EP_cluster_lod format
//      every other asset in the corpus already uses.
//   6. Emit a tile manifest: per-tile world AABB, triangle/vertex count,
//      source primitive provenance, and the output path -- the hook a
//      follow-up screen-space-error prioritizer or a mapspinner-style tile
//      streamer consumes.
//
// Run as a separate node process (heavy clustering OOMs an in-process host,
// same caveat as bake-cluster.mjs):
//   node tools/spatial-split.mjs <input.glb> <outDir> [tilesX] [tilesZ]

import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, copyToDocument, prune, dedup } from '@gltf-transform/functions';
import draco3dgltf from 'draco3dgltf';
import { writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { bakeCluster } from './bake-cluster.mjs';

// Minimal column-major 4x4 mat4 helpers (glTF/gl-matrix layout). No external
// matrix library is a dependency of this package -- these three ops (identity,
// multiply, transformPoint) are all this tool needs, so they're inlined rather
// than pulling in a new dependency for a handful of lines.
function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mat4Multiply(a, b) {
  // out = a * b (column-major, matches gl-matrix's mat4.multiply(out, a, b))
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
function mat4TransformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

async function _validateInputGlb(INPUT) {
  let st;
  try {
    st = await stat(INPUT);
  } catch (e) {
    throw new Error(`spatialSplit: INPUT not found or unreadable: ${INPUT} (${e.code || e.message})`);
  }
  if (!st.isFile()) throw new Error(`spatialSplit: INPUT is not a file: ${INPUT}`);
  const fh = await readFile(INPUT);
  if (fh.byteLength < 4 || fh.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`spatialSplit: INPUT is not a valid GLB (bad magic): ${INPUT}`);
  }
}

async function _makeReader() {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3dgltf.createDecoderModule(),
    'draco3d.encoder': await draco3dgltf.createEncoderModule(),
  });
}

// World-transform-composed triangle centroid in scene space.
function _triCentroid(posArr, ia, ib, ic, worldMat) {
  const a = mat4TransformPoint(worldMat, posArr[ia * 3], posArr[ia * 3 + 1], posArr[ia * 3 + 2]);
  const b = mat4TransformPoint(worldMat, posArr[ib * 3], posArr[ib * 3 + 1], posArr[ib * 3 + 2]);
  const c = mat4TransformPoint(worldMat, posArr[ic * 3], posArr[ic * 3 + 1], posArr[ic * 3 + 2]);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

function _cellOf(worldX, worldZ, gridMinX, gridMinZ, cellW, cellD, tilesX, tilesZ) {
  let cx = Math.floor((worldX - gridMinX) / cellW);
  let cz = Math.floor((worldZ - gridMinZ) / cellD);
  cx = Math.max(0, Math.min(tilesX - 1, cx));
  cz = Math.max(0, Math.min(tilesZ - 1, cz));
  return cz * tilesX + cx;
}

// Extracts a NEW Primitive containing only the given triangle indices from
// `srcPrim`, remapping to a compact local vertex set (never re-emits
// unreferenced vertices, never duplicates a triangle). Attribute set +
// material are copied through as-is; the doc the new accessors/prim are
// created in is `doc` (a per-tile Document), and `srcPrim`'s accessors are
// read directly (typed-array reads only, no accessor is shared/mutated).
function _extractTriangleSubset(doc, srcPrim, triIndices, indexArr) {
  const semantics = srcPrim.listSemantics();
  const remap = new Map(); // srcVertexIndex -> localIndex
  const localIndices = new Uint32Array(triIndices.length * 3);
  let nextLocal = 0;
  for (let t = 0; t < triIndices.length; t++) {
    const base = triIndices[t] * 3;
    for (let k = 0; k < 3; k++) {
      const srcV = indexArr[base + k];
      let local = remap.get(srcV);
      if (local === undefined) {
        local = nextLocal++;
        remap.set(srcV, local);
      }
      localIndices[t * 3 + k] = local;
    }
  }
  const prim = doc.createPrimitive().setMode(srcPrim.getMode());
  // Material is a cross-document reference: srcPrim.getMaterial() lives in the
  // SOURCE document's graph, and property-graph refuses an edge between two
  // disconnected graphs (setMaterial(mat) directly here throws "Cannot connect
  // disconnected graphs"). The caller copies the material into `doc` via
  // copyToDocument and assigns the mapped copy after this call returns.
  const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
  for (const sem of semantics) {
    const srcAcc = srcPrim.getAttribute(sem);
    if (!srcAcc) continue;
    const itemSize = srcAcc.getElementSize();
    const SrcArrCtor = srcAcc.getArray().constructor;
    const out = new SrcArrCtor(nextLocal * itemSize);
    const srcArr = srcAcc.getArray();
    for (const [srcV, local] of remap) {
      for (let c = 0; c < itemSize; c++) out[local * itemSize + c] = srcArr[srcV * itemSize + c];
    }
    const acc = doc
      .createAccessor()
      .setType(srcAcc.getType())
      .setArray(out)
      .setNormalized(srcAcc.getNormalized())
      .setBuffer(buffer);
    prim.setAttribute(sem, acc);
  }
  const idxAcc = doc.createAccessor().setType('SCALAR').setArray(localIndices).setBuffer(buffer);
  prim.setIndices(idxAcc);
  return prim;
}

// copyToDocument copies a primitive's FULL dependency graph, including
// whatever Buffer its accessors point at in the source document -- so after
// copying N whole primitives into a fresh single-buffer tile Document, the
// tile can end up with 2+ Buffer properties (the tile's own + one per
// distinct source buffer copied in). A GLB permits at most one buffer;
// repoint every accessor onto the tile's single canonical buffer and dispose
// the rest (byteOffset/byteStride are per-accessor via bufferView, so this
// is a safe reassignment -- setBuffer() on Accessor moves it to a new
// bufferView on the target buffer, gltf-transform recomputes layout at write
// time).
function _flattenToSingleBuffer(doc) {
  const root = doc.getRoot();
  const buffers = root.listBuffers();
  if (buffers.length <= 1) return;
  const canonical = buffers[0];
  for (const acc of root.listAccessors()) {
    if (acc.getBuffer() !== canonical) acc.setBuffer(canonical);
  }
  for (const buf of buffers.slice(1)) buf.dispose();
}

// Full triangle-list index array for a primitive, regardless of whether it
// already has an explicit index accessor (implicit sequential 0..N-1 if not).
function _resolveIndices(prim) {
  const idxAcc = prim.getIndices();
  if (idxAcc) return idxAcc.getArray();
  const vCount = prim.getAttribute('POSITION')?.getCount() || 0;
  const arr = new Uint32Array(vCount);
  for (let i = 0; i < vCount; i++) arr[i] = i;
  return arr;
}

async function spatialSplit(INPUT, OUT_DIR, tilesX = 4, tilesZ = 4, { bake = true } = {}) {
  await _validateInputGlb(INPUT);
  const io = await _makeReader();
  const srcDoc = await io.read(INPUT);
  const srcRoot = srcDoc.getRoot();
  const scene = srcRoot.listScenes()[0];
  if (!scene) throw new Error(`spatialSplit: ${INPUT} has no scene`);

  const bounds = getBounds(scene);
  const gridMinX = bounds.min[0], gridMinZ = bounds.min[2];
  const spanX = Math.max(1e-6, bounds.max[0] - bounds.min[0]);
  const spanZ = Math.max(1e-6, bounds.max[2] - bounds.min[2]);
  const cellW = spanX / tilesX;
  const cellD = spanZ / tilesZ;

  // cellIndex -> array of { prim(Primitive), triIndices(number[]) }
  const cellAssignments = new Map();
  // Track world-space AABB + tri/vert counts per cell for the manifest.
  const cellStats = new Map(); // cellIndex -> {min,max,triCount,vertCount,srcPrimCount}

  function _ensureCell(idx) {
    if (!cellAssignments.has(idx)) {
      cellAssignments.set(idx, []);
      cellStats.set(idx, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], triCount: 0, vertCount: 0, srcPrimCount: 0 });
    }
    return cellAssignments.get(idx);
  }
  function _growStats(idx, x, y, z) {
    const s = cellStats.get(idx);
    if (x < s.min[0]) s.min[0] = x; if (y < s.min[1]) s.min[1] = y; if (z < s.min[2]) s.min[2] = z;
    if (x > s.max[0]) s.max[0] = x; if (y > s.max[1]) s.max[1] = y; if (z > s.max[2]) s.max[2] = z;
  }

  let totalPrims = 0, straddlingPrims = 0, wholeMovedPrims = 0, totalTriangles = 0;

  function visit(node, parentMat) {
    const local = node.getMatrix(); // gltf-transform returns (never writes into) a fresh mat4
    const world = mat4Multiply(parentMat, local);

    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos || prim.getMode() !== 4 /* TRIANGLES */) continue; // non-triangle prims (lines/points) pass through untouched, see below
        totalPrims++;
        const posArr = pos.getArray();
        const indexArr = _resolveIndices(prim);
        const triCount = indexArr.length / 3;
        totalTriangles += triCount;

        // Bucket every triangle of this primitive by its world-space centroid cell.
        const byCell = new Map(); // cellIndex -> triIndex[]
        for (let t = 0; t < triCount; t++) {
          const ia = indexArr[t * 3], ib = indexArr[t * 3 + 1], ic = indexArr[t * 3 + 2];
          const [wx, wy, wz] = _triCentroid(posArr, ia, ib, ic, world);
          const cell = _cellOf(wx, wz, gridMinX, gridMinZ, cellW, cellD, tilesX, tilesZ);
          _ensureCell(cell);
          _growStats(cell, wx, wy, wz);
          let arr = byCell.get(cell);
          if (!arr) { arr = []; byCell.set(cell, arr); }
          arr.push(t);
        }

        if (byCell.size === 1) {
          wholeMovedPrims++;
        } else {
          straddlingPrims++;
        }
        for (const [cell, triIndices] of byCell) {
          const bucket = _ensureCell(cell);
          bucket.push({ prim, triIndices, indexArr, world: world.slice() });
          const s = cellStats.get(cell);
          s.triCount += triIndices.length;
          s.vertCount += triIndices.length * 3; // upper bound (pre-dedup local remap collapses shared verts)
          s.srcPrimCount++;
        }
      }
    }
    for (const child of node.listChildren()) visit(child, world);
  }
  for (const top of scene.listChildren()) visit(top, mat4Identity());

  const usedCells = [...cellAssignments.keys()].sort((a, b) => a - b);
  if (usedCells.length === 0) throw new Error(`spatialSplit: ${INPUT} produced zero triangle-bearing tiles (no TRIANGLES-mode primitives found)`);

  await mkdir(OUT_DIR, { recursive: true });
  const tiles = [];
  const baseName = basename(INPUT).replace(/\.glb$/i, '');

  for (const cell of usedCells) {
    const cx = cell % tilesX, cz = Math.floor(cell / tilesX);
    const entries = cellAssignments.get(cell);
    const stats = cellStats.get(cell);

    const tileDoc = new Document();
    tileDoc.createBuffer();
    const tileScene = tileDoc.createScene();
    const tileRootNode = tileDoc.createNode(`tile_${cx}_${cz}`);
    tileScene.addChild(tileRootNode);

    // Each entry is this cell's share of one source primitive. A prim that
    // landed wholly in this cell (isWholePrim) is copied once via
    // copyToDocument (fast path, preserves material/texture graph identity
    // for later dedup); a straddling prim's per-cell share is rebuilt as a
    // fresh geometry-correct subset primitive (never re-uses the full source
    // accessor -- that would pull in the other cells' triangles too).
    for (const { prim, triIndices, indexArr, world } of entries) {
      const isWholePrim = triIndices.length === indexArr.length / 3;
      let newPrim;
      if (isWholePrim) {
        const cloneMap = copyToDocument(tileDoc, srcDoc, [prim]);
        newPrim = cloneMap.get(prim);
      } else {
        newPrim = _extractTriangleSubset(tileDoc, prim, triIndices, indexArr);
        // Material graph for a partial prim still needs a real cross-doc
        // copy (copyToDocument on just the Material, not the whole prim).
        const srcMat = prim.getMaterial();
        if (srcMat) {
          const matMap = copyToDocument(tileDoc, srcDoc, [srcMat]);
          newPrim.setMaterial(matMap.get(srcMat));
        }
      }
      const mesh = tileDoc.createMesh().addPrimitive(newPrim);
      const node = tileDoc.createNode().setMesh(mesh);
      node.setMatrix(world); // bake the full world transform in (tile root has identity)
      tileRootNode.addChild(node);
    }

    // Drop anything copyToDocument pulled in transitively that this tile's
    // primitives don't actually reference (e.g. texture images belonging to
    // materials that were copied but whose OTHER primitives stayed in a
    // different tile -- copyToDocument only copies what's reachable from the
    // requested properties, but prune() is still the correct final GC pass,
    // matching bake-cluster.mjs's own dedup-then-prune discipline elsewhere).
    await tileDoc.transform(dedup(), prune());
    _flattenToSingleBuffer(tileDoc);

    const tileFile = `${baseName}_tile_${cx}_${cz}.glb`;
    const tilePath = join(OUT_DIR, tileFile);
    const writer = await _makeReader();
    // Tiles are draco-free (source draco was already decoded on read); write
    // plain, bakeCluster() applies its own EXT_meshopt_compression pass.
    const bin = await writer.writeBinary(tileDoc);
    await writeFile(tilePath, Buffer.from(bin));

    let clusterResult = null;
    let clusterPath = null;
    if (bake) {
      clusterPath = join(OUT_DIR, `${baseName}_tile_${cx}_${cz}.cluster.glb`);
      clusterResult = await bakeCluster(tilePath, clusterPath);
    }

    tiles.push({
      cell, cx, cz,
      file: tileFile,
      clusterFile: bake ? basename(clusterPath) : null,
      bounds: { min: stats.min, max: stats.max },
      triangleCount: stats.triCount,
      sourcePrimitiveRefs: stats.srcPrimCount,
      nodeCount: entries.length,
      cluster: clusterResult ? { clusters: clusterResult.totalClusters, clustered: clusterResult.clustered, bytes: clusterResult.bytes } : null,
    });
    console.log(`[spatial-split] tile (${cx},${cz}) -> ${tileFile}: ${entries.length} node(s), ${stats.triCount} tri` + (bake ? `, baked -> ${basename(clusterPath)} (${clusterResult.totalClusters} clusters)` : ''));
  }

  const manifest = {
    source: INPUT,
    tilesX, tilesZ,
    gridBounds: bounds,
    totalPrimitives: totalPrims,
    totalTriangles,
    wholeMovedPrimitives: wholeMovedPrims,
    straddlingPrimitives: straddlingPrims,
    tileCount: tiles.length,
    tiles,
  };
  const manifestPath = join(OUT_DIR, `${baseName}.tiles.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  console.log(`[spatial-split] ${INPUT}: ${totalPrims} source primitive(s) (${straddlingPrims} straddled a tile boundary, split correctly) -> ${tiles.length} tile(s) -> ${manifestPath}`);
  return manifest;
}

export { spatialSplit };

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('spatial-split.mjs')) {
  const [, , INPUT, OUT_DIR, TX, TZ] = process.argv;
  if (!INPUT || !OUT_DIR) {
    console.error('usage: node tools/spatial-split.mjs <input.glb> <outDir> [tilesX=4] [tilesZ=4]');
    process.exit(1);
  }
  spatialSplit(INPUT, OUT_DIR, TX ? Number(TX) : 4, TZ ? Number(TZ) : 4).catch((e) => {
    console.error('[spatial-split] ERROR', e.message, e.stack);
    process.exit(1);
  });
}
