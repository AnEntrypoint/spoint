#!/usr/bin/env node

import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, simplify, cloneDocument } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3dgltf from 'draco3dgltf';
import { buildClusterLod, buildClusterLodExtra, CLUSTER_LOD_EXTRA_KEY } from '../src/meshlet-codec.js';
import { collapseDegenerateTriangles, collapseFanTriangles, dropDegenerateTriangles } from '../src/degenerate-triangles.js';
import { materialConvergenceReport, collapseTrivialMaterialVariants, stampMaterialBucketKeys } from '../src/material-convergence.js';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SKINNED_LOD_RATIOS = [1.0, 0.4, 0.15];
const EP_PROGRESSIVE_LOD_KEY = 'EP_progressive_lod';

const ATTR_RENAME = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', TEXCOORD_0: 'texcoord_0', COLOR_0: 'color' };

function primIsStatic(prim) {
  if (prim.getAttribute('JOINTS_0') || prim.getAttribute('WEIGHTS_0')) return false;
  if (prim.listTargets && prim.listTargets().length) return false;
  return true;
}

function primToGeo(prim, worldMatrices) {
  const semantics = prim.listSemantics();
  const attributes = [];
  for (const sem of semantics) {
    const acc = prim.getAttribute(sem);
    if (!acc) continue;
    const name = ATTR_RENAME[sem] || sem.toLowerCase();
    attributes.push({ name, itemSize: acc.getElementSize(), normalized: acc.getNormalized(), array: acc.getArray(), _sem: sem });
  }
  const idxAcc = prim.getIndices();
  const index = idxAcc ? _dropSourceDegenerates(idxAcc.getArray(), attributes, worldMatrices) : null;
  return { attributes, index, _semByName: Object.fromEntries(attributes.map((a) => [a.name, a._sem])) };
}

function _positionArray(attributes) {
  const posAttr = attributes.find((a) => a.name === 'position');
  return posAttr ? posAttr.array : null;
}

function _dropSourceDegenerates(index, attributes, worldMatrices) {
  const pos = _positionArray(attributes);
  if (!pos) return index;
  const { index: kept, dropped } = dropDegenerateTriangles(index, pos, worldMatrices);
  if (dropped) console.warn(`[bake-cluster] dropped ${dropped} degenerate (zero-area) triangle(s) before clustering`);
  return kept;
}

function _collapseClusteredDegenerates(result, meshIndex, primIndex, worldMatrices) {
  const pos = _positionArray(result.attributes);
  if (!pos) return;
  const degenerate = collapseDegenerateTriangles(result.index, pos, worldMatrices) + collapseDegenerateTriangles(result.indexCoarse, pos, worldMatrices);
  if (degenerate) console.warn(`[bake-cluster] collapsed ${degenerate} post-cluster degenerate (zero-area) triangle(s) (mesh ${meshIndex} prim ${primIndex})`);
  const fan = collapseFanTriangles(result.clusters, pos, [result.index, result.indexCoarse], [0, 0]);
  if (fan) console.warn(`[bake-cluster] collapsed ${fan} fan (out-of-cluster-bounds) triangle(s) (mesh ${meshIndex} prim ${primIndex})`);
}

async function _bakeSkinnedLods(srcDoc, io, meshIndex, primIndex, lodsDir, baseName) {
  const lods = [];
  for (const ratio of SKINNED_LOD_RATIOS) {
    if (ratio >= 1.0) { lods.push({ ratio: 1.0, kind: 'textured', inline: true }); continue; }
    const doc = cloneDocument(srcDoc);
    const root = doc.getRoot();
    const meshes = root.listMeshes();
    const mesh = meshes[meshIndex];
    if (!mesh) break;
    const prims = mesh.listPrimitives();
    const keepPrim = prims[primIndex];
    if (!keepPrim) break;
    for (const m of meshes) {
      for (const p of m.listPrimitives()) { if (p !== keepPrim) m.removePrimitive(p); }
      if (m !== mesh) m.dispose();
    }
    const pos = keepPrim.getAttribute('POSITION');
    if (!pos) break;
    const min = pos.getMinNormalized ? pos.getMin([]) : pos.getMin([]);
    const max = pos.getMax([]);
    const decodeAABB = { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
    try {
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }));
    } catch (e) { continue; }
    const idxAcc = keepPrim.getIndices();
    const vCount = keepPrim.getAttribute('POSITION')?.getCount() || 0;
    const iCount = idxAcc ? idxAcc.getCount() : 0;
    if (iCount === 0 || vCount === 0) continue;
    doc.createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    const bin = await io.writeBinary(doc);
    const fileName = `${baseName}_m${meshIndex}_p${primIndex}_r${String(ratio).replace('.', '')}.glb`;
    await mkdir(lodsDir, { recursive: true });
    await writeFile(join(lodsDir, fileName), Buffer.from(bin));
    lods.push({ ratio, kind: 'textured', path: `lods/${fileName}`, inline: false, indexCount: iCount, vertexCount: vCount, bytes: bin.byteLength, decodeAABB });
  }
  const siblingCount = lods.filter((l) => !l.inline).length;
  if (siblingCount === 0) return null;
  return { meshIndex, primIndex, lods };
}

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

  let clustered = 0, skipped = 0, totalClusters = 0, skinnedLodded = 0;
  const pendingExtras = [];
  const skinnedDescs = [];
  const lodsDir = join(dirname(OUTPUT), 'lods');
  const baseName = 'sk';
  const allMeshes = root.listMeshes();
  const worldMatricesByMesh = new Map(allMeshes.map((m) => [m, []]));
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (mesh) worldMatricesByMesh.get(mesh).push(node.getWorldMatrix());
  }
  for (let mi = 0; mi < allMeshes.length; mi++) {
    const mesh = allMeshes[mi];
    const prims = mesh.listPrimitives();
    for (let pi = 0; pi < prims.length; pi++) {
      const prim = prims[pi];
      if (!primIsStatic(prim)) {
        try {
          const desc = await _bakeSkinnedLods(doc, io, mi, pi, lodsDir, baseName);
          if (desc) { skinnedDescs.push(desc); skinnedLodded++; }
          else skipped++;
        } catch (e) { console.warn(`[bake-cluster] skinned LOD skipped (mesh ${mi} prim ${pi}): ${e.message}`); skipped++; }
        continue;
      }
      const worldMatrices = worldMatricesByMesh.get(mesh);
      const geo = primToGeo(prim, worldMatrices);
      if (!geo.attributes.find((a) => a.name === 'position')) { skipped++; continue; }

      const result = await buildClusterLod(geo, { maxVertices: 64, maxTriangles: 128, lodRatios: [1, 0.5, 0.25], lodError: 0.02 });
      if (!result.clusters.length) { skipped++; continue; }
      if (!buffer) throw new Error(`bakeCluster: document has a clusterable static primitive (mesh ${mi} prim ${pi}) but no buffer to write the reordered accessors into (root.listBuffers() is empty) -- malformed glTF`);

      _collapseClusteredDegenerates(result, mi, pi, worldMatrices);

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
      const idxAcc = doc.createAccessor().setName(`EP_cluster_lod0_m${mi}_p${pi}`).setType('SCALAR').setArray(result.index).setBuffer(buffer);
      prim.setIndices(idxAcc);

      let coarseAcc = null;
      if (result.indexCoarse.length) {
        coarseAcc = doc.createAccessor().setName(`EP_cluster_lod_coarse_m${mi}_p${pi}`).setType('SCALAR').setArray(result.indexCoarse).setBuffer(buffer);
      }
      pendingExtras.push({ prim, result, coarseAcc, mi, pi });

      clustered++;
      totalClusters += result.clusters.length;
    }
  }

  for (const ext of root.listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
  }

  await doc.transform(dedup({ propertyTypes: [PropertyType.MESH, PropertyType.TEXTURE, PropertyType.MATERIAL, PropertyType.SKIN] }));

  const materialCollapse = collapseTrivialMaterialVariants(doc);
  const materialReport = materialConvergenceReport(doc);
  const materialBuckets = stampMaterialBucketKeys(doc);

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

  if (skinnedDescs.length) {
    bin = _spliceProgressiveLod(bin, skinnedDescs);
  }

  await writeFile(OUTPUT, Buffer.from(bin));
  console.log(`[bake-cluster] ${INPUT} -> ${OUTPUT}: clustered ${clustered} prim(s), ${totalClusters} clusters, skinned-lodded ${skinnedLodded} prim(s), skipped ${skipped}, ${(bin.byteLength / 1024).toFixed(1)} KiB, materials ${materialReport.materialCount} (${materialCollapse.merged} trivial-collapsed, convergence ${materialReport.convergenceRatio}), ${pendingExtras.length} cluster prim(s) stamped with a materialBucket`);
  return { clustered, skipped, totalClusters, skinnedLodded, bytes: bin.byteLength, materialReport, materialCollapse };
}

function _spliceProgressiveLod(bin, meshes) {
  const u8 = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return bin;
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
  json.extensions = json.extensions || {};
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
