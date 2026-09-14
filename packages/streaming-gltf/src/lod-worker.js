const DECIMATE_GRID_RES_START = 6;
const DECIMATE_GRID_RES_MAX = 64;

let THREE = null;
let GLTFLoader = null;
let MeshoptDecoder = null;
let loader = null;
let readyResolve;
const readyPromise = new Promise((r) => { readyResolve = r; });

(async () => {
  try {
    const threeMod = await import('https://esm.sh/three@0.170.0');
    THREE = threeMod;
    const gltfMod = await import('https://esm.sh/three@0.170.0/examples/jsm/loaders/GLTFLoader.js?deps=three@0.170.0');
    GLTFLoader = gltfMod.GLTFLoader;
    const meshoptMod = await import('https://esm.sh/three@0.170.0/examples/jsm/libs/meshopt_decoder.module.js?deps=three@0.170.0');
    MeshoptDecoder = meshoptMod.MeshoptDecoder;
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    try {
      const dracoSrc = await (await fetch(new URL('./draco-loader.js', self.location.href))).text();
      const patched = dracoSrc.replace(
        /from\s*["']three["']/g,
        "from 'https://esm.sh/three@0.170.0'"
      );
      const blobUrl = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
      const dracoMod = await import(blobUrl);
      URL.revokeObjectURL(blobUrl);
      loader.setDRACOLoader(new dracoMod.DRACOLoader());
    } catch (de) {
      self.postMessage({ id: 0, ok: true, ready: false, warn: 'worker draco init failed: ' + String(de && (de.message || de)) });
    }
    readyResolve(true);
    self.postMessage({ id: 0, ok: true, ready: true });
  } catch (e) {
    self.postMessage({ id: 0, ok: false, ready: true, error: 'worker init: ' + String(e && (e.stack || e.message || e)) });
    readyResolve(false);
  }
})();

self.addEventListener('error', (e) => {
  try {
    self.postMessage({ id: 0, ok: false, ready: true, error: 'worker self.error: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') });
  } catch {}
});

function _bakeQuantizeDecode(geo, matrix, decodeAABB) {
  const m = matrix;
  const isIdentity = !decodeAABB && (
    m.elements[0] === 1 && m.elements[5] === 1 && m.elements[10] === 1 &&
    m.elements[12] === 0 && m.elements[13] === 0 && m.elements[14] === 0 &&
    m.elements[1] === 0 && m.elements[2] === 0 && m.elements[4] === 0 &&
    m.elements[6] === 0 && m.elements[8] === 0 && m.elements[9] === 0
  );
  if (!decodeAABB && !isIdentity) {
    for (const semKey of ['position', 'normal', 'tangent']) {
      const a = geo.attributes[semKey];
      if (!a) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        if (a.itemSize >= 1) out[i * a.itemSize + 0] = a.getX(i);
        if (a.itemSize >= 2) out[i * a.itemSize + 1] = a.getY(i);
        if (a.itemSize >= 3) out[i * a.itemSize + 2] = a.getZ(i);
        if (a.itemSize >= 4) out[i * a.itemSize + 3] = a.getW(i);
      }
      geo.setAttribute(semKey, new THREE.BufferAttribute(out, a.itemSize, false));
    }
    geo.applyMatrix4(m);
  } else if (decodeAABB) {
    const { min, max } = decodeAABB;
    const pos = geo.attributes.position;
    if (pos) {
      let smnX = Infinity, smxX = -Infinity;
      let smnY = Infinity, smxY = -Infinity;
      let smnZ = Infinity, smxZ = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < smnX) smnX = x; if (x > smxX) smxX = x;
        if (y < smnY) smnY = y; if (y > smxY) smxY = y;
        if (z < smnZ) smnZ = z; if (z > smxZ) smxZ = z;
      }
      const r = (a, b) => (b - a < 1e-9 ? 1 : b - a);
      const sx = (max[0] - min[0]) / r(smnX, smxX);
      const sy = (max[1] - min[1]) / r(smnY, smxY);
      const sz = (max[2] - min[2]) / r(smnZ, smxZ);
      const out = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        out[i * 3 + 0] = (pos.getX(i) - smnX) * sx + min[0];
        out[i * 3 + 1] = (pos.getY(i) - smnY) * sy + min[1];
        out[i * 3 + 2] = (pos.getZ(i) - smnZ) * sz + min[2];
      }
      geo.setAttribute('position', new THREE.BufferAttribute(out, 3, false));
      for (const semKey of ['normal', 'tangent']) {
        const a = geo.attributes[semKey];
        if (!a) continue;
        const o = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) {
          if (a.itemSize >= 1) o[i * a.itemSize + 0] = a.getX(i);
          if (a.itemSize >= 2) o[i * a.itemSize + 1] = a.getY(i);
          if (a.itemSize >= 3) o[i * a.itemSize + 2] = a.getZ(i);
          if (a.itemSize >= 4) o[i * a.itemSize + 3] = a.getW(i);
        }
        geo.setAttribute(semKey, new THREE.BufferAttribute(o, a.itemSize, false));
      }
    }
  }
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
}

function _clusterDecimate(geo, triCap) {
  const pos = geo.attributes.position;
  if (!pos) return;
  let ix = geo.index;
  if (!ix) { const seq = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) seq[i] = i; ix = { array: seq, count: pos.count }; }
  const triCount = ix.count / 3;
  if (triCount <= triCap) return;
  const idx = ix.array;
  const px = pos.array, pStride = pos.itemSize;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = px[i * pStride], y = px[i * pStride + 1], z = px[i * pStride + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const sx = (mxx - mnx) || 1, sy = (mxy - mny) || 1, sz = (mxz - mnz) || 1;
  const nrm = geo.attributes.normal, col = geo.attributes.color;
  for (let res = DECIMATE_GRID_RES_START; res <= DECIMATE_GRID_RES_MAX; res *= 2) {
    const keptIndexOfVertex = new Int32Array(pos.count);
    const keptIndexOfCell = new Map();
    let kept = 0;
    for (let i = 0; i < pos.count; i++) {
      const gx = Math.min(res - 1, ((px[i * pStride] - mnx) / sx * res) | 0);
      const gy = Math.min(res - 1, ((px[i * pStride + 1] - mny) / sy * res) | 0);
      const gz = Math.min(res - 1, ((px[i * pStride + 2] - mnz) / sz * res) | 0);
      const key = (gx * res + gy) * res + gz;
      let rep = keptIndexOfCell.get(key);
      if (rep === undefined) { rep = kept++; keptIndexOfCell.set(key, rep); }
      keptIndexOfVertex[i] = rep;
    }
    const out = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = keptIndexOfVertex[idx[t]], b = keptIndexOfVertex[idx[t + 1]], c = keptIndexOfVertex[idx[t + 2]];
      if (a !== b && b !== c && a !== c) { out.push(a, b, c); }
    }
    const outTris = out.length / 3;
    if (outTris <= triCap || res === DECIMATE_GRID_RES_MAX) {
      if (outTris < 1) return;
      const sourceVertexOfKept = new Int32Array(kept).fill(-1);
      for (let i = 0; i < pos.count; i++) { const r = keptIndexOfVertex[i]; if (sourceVertexOfKept[r] === -1) sourceVertexOfKept[r] = i; }
      const newPos = new Float32Array(kept * 3);
      const ct = col ? col.itemSize : 0;
      const newNrm = nrm ? new Float32Array(kept * 3) : null;
      const newCol = col ? new Float32Array(kept * ct) : null;
      for (let r = 0; r < kept; r++) {
        const s = sourceVertexOfKept[r];
        newPos[r * 3] = pos.getX(s); newPos[r * 3 + 1] = pos.getY(s); newPos[r * 3 + 2] = pos.getZ(s);
        if (newNrm) { newNrm[r * 3] = nrm.getX(s); newNrm[r * 3 + 1] = nrm.getY(s); newNrm[r * 3 + 2] = nrm.getZ(s); }
        if (newCol) {
          newCol[r * ct] = col.getX(s);
          if (ct >= 2) newCol[r * ct + 1] = col.getY(s);
          if (ct >= 3) newCol[r * ct + 2] = col.getZ(s);
          if (ct >= 4) newCol[r * ct + 3] = col.getW(s);
        }
      }
      geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3, false));
      if (newNrm) geo.setAttribute('normal', new THREE.BufferAttribute(newNrm, 3, false));
      if (newCol) geo.setAttribute('color', new THREE.BufferAttribute(newCol, ct, false));
      geo.setIndex(new THREE.BufferAttribute(kept > 65535 ? new Uint32Array(out) : new Uint16Array(out), 1));
      return;
    }
  }
}

function extractGeometry(geo) {
  const attrs = {};
  for (const k of Object.keys(geo.attributes)) {
    const a = geo.attributes[k];
    let arr;
    let normalized = a.normalized;
    if (k === 'normal' && a.itemSize === 3) {
      arr = new Int8Array(a.count * 3);
      for (let i = 0; i < a.count; i++) {
        arr[i * 3 + 0] = Math.max(-127, Math.min(127, Math.round(a.getX(i) * 127)));
        arr[i * 3 + 1] = Math.max(-127, Math.min(127, Math.round(a.getY(i) * 127)));
        arr[i * 3 + 2] = Math.max(-127, Math.min(127, Math.round(a.getZ(i) * 127)));
      }
      normalized = true;
    } else if (a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array)) {
      arr = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        if (a.itemSize >= 1) arr[i * a.itemSize + 0] = a.getX(i);
        if (a.itemSize >= 2) arr[i * a.itemSize + 1] = a.getY(i);
        if (a.itemSize >= 3) arr[i * a.itemSize + 2] = a.getZ(i);
        if (a.itemSize >= 4) arr[i * a.itemSize + 3] = a.getW(i);
      }
    } else {
      arr = new Float32Array(a.array.buffer.slice(a.array.byteOffset, a.array.byteOffset + a.array.byteLength));
    }
    attrs[k] = { array: arr, itemSize: a.itemSize, normalized };
  }
  let index = null;
  if (geo.index) {
    const ia = geo.index.array;
    if (ia instanceof Uint32Array) index = new Uint32Array(ia);
    else if (ia instanceof Uint16Array) index = new Uint16Array(ia);
    else index = new Uint32Array(ia);
  }
  const bs = geo.boundingSphere;
  const bb = geo.boundingBox;
  return {
    attrs,
    index,
    boundingSphere: bs ? { center: [bs.center.x, bs.center.y, bs.center.z], radius: bs.radius } : null,
    boundingBox: bb ? { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] } : null,
  };
}

function payloadTransferables(payload) {
  const list = [];
  for (const k of Object.keys(payload.attrs)) list.push(payload.attrs[k].array.buffer);
  if (payload.index) list.push(payload.index.buffer);
  return list;
}

self.addEventListener('message', async (ev) => {
  const { id, url, decodeAABB, sloppyCap } = ev.data;
  try {
    const ok = await readyPromise;
    if (!ok || !loader) throw new Error('worker not initialized');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const buf = await res.arrayBuffer();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(buf, '', resolve, reject);
    });
    let srcMesh = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((c) => { if (c.isMesh && !srcMesh) srcMesh = c; });
    if (!srcMesh) throw new Error('no mesh in LOD sibling');
    _bakeQuantizeDecode(srcMesh.geometry, srcMesh.matrixWorld, decodeAABB);
    if (sloppyCap) {
      try { _clusterDecimate(srcMesh.geometry, sloppyCap); } catch (e) { }
    }
    const payload = extractGeometry(srcMesh.geometry);
    payload.bytes = buf.byteLength;
    self.postMessage({ id, ok: true, payload }, payloadTransferables(payload));
  } catch (e) {
    self.postMessage({ id, ok: false, error: `${String(e && e.message || e)} (url: ${url})` });
  }
});
