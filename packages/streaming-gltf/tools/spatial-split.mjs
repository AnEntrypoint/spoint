#!/usr/bin/env node

import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, copyToDocument, prune, dedup } from '@gltf-transform/functions';
import draco3dgltf from 'draco3dgltf';
import { writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { bakeCluster } from './bake-cluster.mjs';

function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mat4Multiply(a, b) {
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

function _extractTriangleSubset(doc, srcPrim, triIndices, indexArr) {
  const semantics = srcPrim.listSemantics();
  const remap = new Map();
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

  const cellAssignments = new Map();
  const cellStats = new Map();

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
    const local = node.getMatrix();
    const world = mat4Multiply(parentMat, local);

    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos || prim.getMode() !== 4 ) continue;
        totalPrims++;
        const posArr = pos.getArray();
        const indexArr = _resolveIndices(prim);
        const triCount = indexArr.length / 3;
        totalTriangles += triCount;

        const byCell = new Map();
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
          s.vertCount += triIndices.length * 3;
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

    for (const { prim, triIndices, indexArr, world } of entries) {
      const isWholePrim = triIndices.length === indexArr.length / 3;
      let newPrim;
      if (isWholePrim) {
        const cloneMap = copyToDocument(tileDoc, srcDoc, [prim]);
        newPrim = cloneMap.get(prim);
      } else {
        newPrim = _extractTriangleSubset(tileDoc, prim, triIndices, indexArr);
        const srcMat = prim.getMaterial();
        if (srcMat) {
          const matMap = copyToDocument(tileDoc, srcDoc, [srcMat]);
          newPrim.setMaterial(matMap.get(srcMat));
        }
      }
      const mesh = tileDoc.createMesh().addPrimitive(newPrim);
      const node = tileDoc.createNode().setMesh(mesh);
      node.setMatrix(world);
      tileRootNode.addChild(node);
    }

    await tileDoc.transform(dedup(), prune());
    _flattenToSingleBuffer(tileDoc);

    const tileFile = `${baseName}_tile_${cx}_${cz}.glb`;
    const tilePath = join(OUT_DIR, tileFile);
    const writer = await _makeReader();
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
