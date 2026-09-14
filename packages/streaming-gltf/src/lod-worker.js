import { applyGridDecimate } from './grid-decimate.js';

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
    if (sloppyCap) applyGridDecimate(srcMesh.geometry, sloppyCap, THREE.BufferAttribute);
    const payload = extractGeometry(srcMesh.geometry);
    payload.bytes = buf.byteLength;
    self.postMessage({ id, ok: true, payload }, payloadTransferables(payload));
  } catch (e) {
    self.postMessage({ id, ok: false, error: `${String(e && e.message || e)} (url: ${url})` });
  }
});
