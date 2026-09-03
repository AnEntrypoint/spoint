// Stress demo for ModelPool tier system. Spawns unique-asset entities across
// a wide grid, runs orbiting camera, shows live perf + tier counts.

import * as THREE from 'three';
import { ModelPool } from '../../src/model-pool.js';
import { enableDrawCallBatching } from './draw-call-batching.js';

// Asset source. By default the cluster-LOD models are loaded CROSS-ORIGIN from
// the public assets host (its own GitHub Pages site) so this repo ships code only
// — no model bytes, no LFS. Override with ?assets=<baseUrl>, or ?assets=local to
// use the dev server's generated /assets-list.json. ASSET_DIRS ends up holding
// FULLY-RESOLVED .cluster.glb URLs (each renders via the model-pool cluster path).
const _assetsParam = new URLSearchParams(location.search).get('assets');
const ASSET_HOST_DEFAULT = 'https://anentrypoint.github.io/assets/';
const ASSET_BASE = (!_assetsParam || _assetsParam === 'remote')
  ? ASSET_HOST_DEFAULT
  : (_assetsParam === 'local' ? null : (_assetsParam.endsWith('/') ? _assetsParam : _assetsParam + '/'));

let ASSET_DIRS = []; // fully-resolved .cluster.glb URLs
const ASSET_DIRS_READY = (ASSET_BASE === null
  // LOCAL DEV: dynamic /assets-list.json from serve.mjs -> relative cluster paths.
  ? fetch('/assets-list.json').then((r) => r.json())
      .then((list) => list.map((p) => (typeof p === 'string' ? p : p.path)))
  // REMOTE: the assets host's unified manifest.json (category -> [{name,path,thumb}]),
  // where path = streaming-cluster/<name>.cluster.glb. Flatten + resolve each path
  // against ASSET_BASE so the cluster models stream cross-origin.
  : fetch(`${ASSET_BASE}manifest.json`).then((r) => r.json())
      .then((manifest) => Object.values(manifest).flat()
        .map((e) => e && e.path).filter(Boolean)
        .map((path) => ASSET_BASE + path)))
  .then((urls) => { ASSET_DIRS = urls; console.log(`[stress] ${urls.length} cluster assets discovered (${ASSET_BASE || 'local'})`); return urls; })
  .catch((e) => { console.error('[stress] asset list fetch failed', e); ASSET_DIRS = []; });

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
// Opaque-only scene: skip THREE's per-frame transparency depth-sort of the
// render list. Also stop auto-resetting renderer.info every render (we read it
// from the HUD; reset manually once per frame in tick()).
renderer.sortObjects = false;
renderer.info.autoReset = false;
const scene = new THREE.Scene();
// All scene roots here are static (entities self-manage their matrices via the
// pool); disable the per-frame matrix-world traversal recompute on the scene
// and camera roots.
scene.matrixAutoUpdate = false;
scene.background = new THREE.Color(0x181820);
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.0));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(20, 30, 20);
scene.add(dir);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
camera.position.set(30, 18, 30);
camera.lookAt(0, 1, 0);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const pool = new ModelPool({
  scene, renderer, camera,
  targetFps: 60,
  byteBudget: 256 * 1024 * 1024,
  maxConcurrentFetches: 32, // Increased from 6 to maximize asset loading throughput
  // FAR tier via one shared THREE.BatchedMesh — collapses all distinct far-asset
  // draws into ~6 (was 742). After far decimation the scene is draw-call-bound,
  // so this is now a real win: measured 68-70 FPS median (vs 63 baseline) at 500
  // distinct, max peaks 140+ (vs ~92). Renders correctly — an earlier "renders
  // off-screen" reading was a coverage-metric artifact at a far camera (498 tiny
  // dots = ~2% coverage with OR without batching; identical coverage confirmed
  // at matched cameras, and HIGHER close-up: 0.53 vs 0.47).
  useBatchedFarTier: true,
  // Octahedral impostor FINAL LOD — opt in with ?impostor=1 (optionally
  // &impostorPx=NN to tune the enter-distance). Below that on-screen size each
  // model collapses to one LIT billboard (localized @three.ez/octahedron-imposter,
  // via a 1024 MRT atlas per asset) — one InstancedMesh draw per distinct asset.
  // &impostorTextureSize=NN, &impostorMaxAssets=NN, &impostorHemiOcta=1 tune it.
  useImpostorFinalLod: new URLSearchParams(location.search).get('impostor') === '1',
  impostorPx: Number(new URLSearchParams(location.search).get('impostorPx')) || 14,
  // Pass-through only when explicitly set; otherwise the pool default applies.
  impostorCellBudget: Number(new URLSearchParams(location.search).get('impostorCellBudget')) || undefined,
  impostorTextureSize: Number(new URLSearchParams(location.search).get('impostorTextureSize')) || undefined,
  impostorMaxAssets: Number(new URLSearchParams(location.search).get('impostorMaxAssets')) || undefined,
  impostorHemiOcta: new URLSearchParams(location.search).get('impostorHemiOcta') === '1',
  impostorFade: new URLSearchParams(location.search).get('impostorFade') === '1',
});
window.__pool = pool;

// Draw-call batching (per-asset InstancedBatch) is superseded by the BatchedMesh
// FAR tier when that's on; only enable the old path otherwise.
if (!pool._useBatchedFarTier) enableDrawCallBatching(pool);

const proxies = new Set();

async function spawnUnique(n) {
  await ASSET_DIRS_READY;
  if (!ASSET_DIRS.length) {
    console.error('[stress] no assets available to spawn');
    return;
  }
  // Distribute entities across a square grid; each entity picks an asset
  // from the full ASSET_DIRS list (modulo), so up to len(ASSET_DIRS) of
  // them are unique.
  const side = Math.ceil(Math.sqrt(n));
  const spacing = 1.5;
  let count = 0;
  const batchSize = 10;

  async function spawnBatch() {
    let batchCount = 0;
    for (let row = 0; row < side && count < n; row++) {
      for (let col = 0; col < side && count < n; col++) {
        const x = (col - side / 2) * spacing;
        const z = (row - side / 2) * spacing;
        const assetUrl = ASSET_DIRS[count % ASSET_DIRS.length];
        const proxy = pool.spawn(assetUrl, {
          position: [x, 0, z],
          rotation: [0, (count * 0.137) % (Math.PI * 2), 0],
          static: true,
        });
        scene.add(proxy.root);
        proxies.add(proxy);
        count++;
        batchCount++;

        // Yield to browser after every batchSize entities
        if (batchCount >= batchSize) {
          batchCount = 0;
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      }
    }
  }

  await spawnBatch();
  console.log(`[stress] spawned ${count} entities`);
}

document.querySelectorAll('#panel button[data-n]').forEach((btn) => {
  btn.addEventListener('click', () => spawnUnique(+btn.dataset.n));
});
// Spawn every distinct model exactly once. Because spawnUnique picks
// ASSET_DIRS[count % len], spawning exactly len entities yields one of each
// distinct asset. Raise the byte budget first so the resident set can hold the
// full variety instead of evicting most of it (which would hide models).
async function spawnAll() {
  await ASSET_DIRS_READY;
  const n = ASSET_DIRS.length;
  if (!n) { console.error('[stress] no assets to spawn'); return 0; }
  // ~3MB resident headroom per distinct model at low LOD; clamp to a sane max.
  const wantBudgetMB = Math.min(4096, Math.max(256, Math.ceil(n * 3)));
  pool.byteBudget = wantBudgetMB * 1024 * 1024;
  const bb = document.getElementById('byte-budget');
  if (bb) bb.value = wantBudgetMB;
  // The LOD unload manager has its OWN budget (default 200MB) and evicts LODs
  // above ~0.85*budget. 954 distinct models exceed 200MB, so without raising it
  // the manager removes models shortly after they spawn ("added then removed,
  // leaving a small group"). Raise it to match the byte budget. (Deliberately
  // do NOT disable deferred streaming — that prevents geometry from loading.)
  if (pool._lodUnloadManager) {
    pool._lodUnloadManager.vramBudgetMB = wantBudgetMB;
    pool._lodUnloadManager.vramBudgetBytes = wantBudgetMB * 1024 * 1024;
  }
  console.log(`[stress] spawning ALL ${n} distinct models, byteBudget=${wantBudgetMB}MB (unload budget raised)`);
  await spawnUnique(n);
  return n;
}
document.getElementById('spawn-all').addEventListener('click', spawnAll);

// --- Debug surface -------------------------------------------------------
// window.__debug gives one-call visibility into every part of the pipeline so
// the blank-models / LOD-vs-camera / mass-removal issues are directly
// observable from a single page.evaluate() call (no source spelunking needed).
function _entityResolved(e) {
  // An entity is "resolved" (should draw something) if any tracked mesh has a
  // real instanced slot OR an own mesh with non-empty geometry.
  if (!e || e._disposed) return false;
  for (const tm of e.trackedMeshes || []) {
    if (tm._instancedSlot && tm._instancedSlotIdx >= 0) return true;
    const g = tm.mesh && tm.mesh.geometry;
    if (tm.mesh && tm.mesh.visible !== false && g && g.attributes && g.attributes.position && g.attributes.position.count > 0) return true;
  }
  return false;
}
window.THREE = THREE; // expose for debug/perf probes (BatchedMesh tests etc.)
window.__debug = {
  pool, scene, camera, renderer, proxies, THREE,
  spawnAll, clear: () => { for (const p of proxies) p.dispose(); proxies.clear(); },
  spawn: (n) => spawnUnique(n),
  setCamera(x, y, z, tx = 0, ty = 0, tz = 0) {
    camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld();
    return { pos: [x, y, z], target: [tx, ty, tz] };
  },
  // currentLod histogram across all live entities' tracked meshes.
  lodHistogram() {
    const h = {};
    for (const e of pool._entities) for (const tm of e.trackedMeshes || []) {
      const k = tm._instancedSlot ? `lod${tm.currentLod}(inst)` : `lod${tm.currentLod}`;
      h[k] = (h[k] || 0) + 1;
    }
    return h;
  },
  tierBreakdown() {
    let hero = 0, mid = 0, far = 0, none = 0;
    for (const e of pool._entities) {
      const t = e._assignedTier;
      if (t === 'hero') hero++; else if (t === 'mid') mid++; else if (t === 'far') far++; else none++;
    }
    return { hero, mid, far, unassigned: none };
  },
  // Entities the renderer thinks are visible but that have nothing to draw —
  // the white/disappearing models.
  blankEntities() {
    const blanks = [];
    for (const e of pool._entities) {
      if (e._disposed) continue;
      if (e.root.visible && !_entityResolved(e)) {
        blanks.push({ id: e.id, url: e.asset && e.asset.url, lod: (e.trackedMeshes[0] || {}).currentLod, dist: +(e._currentDistance || 0).toFixed(1) });
      }
    }
    return { count: blanks.length, sample: blanks.slice(0, 10) };
  },
  assetLoadState() {
    let cachedGeo = 0, assets = 0;
    for (const a of pool._assets.values()) { assets++; cachedGeo += (a.geoCache ? a.geoCache.size : 0); }
    return { assets, cachedGeometries: cachedGeo, deferredQueue: pool._deferredLoadQueue ? pool._deferredLoadQueue.getStats() : null };
  },
  snapshot() {
    const s = pool.getStats();
    let resolved = 0, blank = 0, totalEntities = 0;
    for (const e of pool._entities) {
      if (e._disposed) continue; totalEntities++;
      if (_entityResolved(e)) resolved++; else if (e.root.visible) blank++;
    }
    return {
      entities: totalEntities, distinctAssets: s.assets, visible: s.visible,
      resolved, blank, hero: s.hero, mid: s.mid, far: s.far,
      drawCalls: s.drawCalls, fps: Math.round(s.fps),
      ceilingLod: pool._currentCeilingLod, midPx: +pool.midPx.toFixed(0),
      totalMB: +(pool._totalBytes / 1048576).toFixed(0), budgetMB: +(pool.byteBudget / 1048576).toFixed(0),
      estVramMB: pool._estimatedVramMB,
      vramRatio: pool._vramRatioMonitor ? +pool._vramRatioMonitor.currentRatio.toFixed(2) : null,
      camPos: [camera.position.x, camera.position.y, camera.position.z].map((v) => +v.toFixed(1)),
      lodHistogram: this.lodHistogram(),
    };
  },
  // Toggle the global material pool (FAR vertex-color grouping) on/off live.
  materialPool(on) { pool._globalMaterialPool._useGlobalMaterialPool = !!on; return on; },
  // Inspect one entity in detail: per-trackedMesh LOD, material kind, whether it
  // has a texture map, its color-attr range, and the mesh's world rotation —
  // used to chase "some LODs change orientation / lose color".
  inspect(i = 0) {
    const ents = [...pool._entities].filter((e) => !e._disposed);
    const e = ents[i]; if (!e) return { err: 'no entity ' + i, total: ents.length };
    const tms = (e.trackedMeshes || []).map((tm) => {
      const m = tm.mesh && tm.mesh.material;
      const g = tm.mesh && tm.mesh.geometry;
      const col = g && g.attributes && g.attributes.color;
      let colMax = null;
      if (col) { const a = col.array; let mx = 0; for (let j = 0; j < Math.min(a.length, 900); j++) if (a[j] > mx) mx = a[j]; colMax = +mx.toFixed(2); }
      const q = tm.mesh ? tm.mesh.getWorldQuaternion(new THREE.Quaternion()) : null;
      return {
        currentLod: tm.currentLod, instanced: !!tm._instancedSlot,
        matType: m && m.type, hasMap: !!(m && m.map), vertexColors: !!(m && m.vertexColors),
        colorAttr: col ? { itemSize: col.itemSize, normalized: col.normalized, max: colMax } : null,
        worldQuat: q ? [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(3)) : null,
        meshVisible: tm.mesh ? tm.mesh.visible : null,
      };
    });
    return { id: e.id, url: e.asset && e.asset.url, rootRot: [e.root.rotation.x, e.root.rotation.y, e.root.rotation.z].map((v) => +v.toFixed(3)), dist: +(e._currentDistance || 0).toFixed(1), trackedMeshes: tms };
  },
  // Pin/unpin the LOD ceiling so a single LOD level can be inspected in isolation
  // (lets us see whether a SPECIFIC lod changes orientation/loses color).
  pinLod(n) { pool._currentCeilingLod = n; pool.ceilingLod = n; return n; },
  unpinLod() { pool._currentCeilingLod = null; return null; },
  // Compare every cached LOD geometry of the asset behind entity i: bbox center
  // + half-extents + sign of (v - bboxCenter) for the same vertex index. If two
  // LODs disagree on the SIGN of an axis they are mirrored relative to each
  // other -> the on-screen orientation flip. Loads all sibling LODs first.
  async compareLods(i = 0) {
    const ents = [...pool._entities].filter((e) => !e._disposed);
    const e = ents[i]; if (!e) return { err: 'no entity ' + i };
    const asset = e.asset;
    const out = [];
    for (let md = 0; md < asset.meshLodDescs.length; md++) {
      const desc = asset.meshLodDescs[md];
      for (let li = 0; li < desc.lods.length; li++) {
        let geo = null;
        try { geo = await asset.ensureMeshLod(md, li); } catch (err) { out.push({ md, li, err: String(err) }); continue; }
        if (!geo) { out.push({ md, li, inline: !!desc.lods[li].inline, geo: null }); continue; }
        if (!geo.boundingBox) geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const c = bb.getCenter(new THREE.Vector3());
        const sz = bb.getSize(new THREE.Vector3());
        const p = geo.attributes.position;
        // sign pattern of first 4 verts relative to bbox center (orientation fingerprint)
        const sig = [];
        for (let k = 0; k < Math.min(4, p.count); k++) {
          sig.push([Math.sign(+(p.getX(k) - c.x).toFixed(4)), Math.sign(+(p.getY(k) - c.y).toFixed(4)), Math.sign(+(p.getZ(k) - c.z).toFixed(4))]);
        }
        out.push({
          md, li, inline: !!desc.lods[li].inline, kind: desc.lods[li].kind,
          center: [c.x, c.y, c.z].map((v) => +v.toFixed(3)),
          size: [sz.x, sz.y, sz.z].map((v) => +v.toFixed(3)),
          v0: [p.getX(0), p.getY(0), p.getZ(0)].map((v) => +v.toFixed(3)),
          sig,
        });
      }
    }
    return { url: asset.url, lods: out };
  },
};
console.log('[stress] window.__debug ready — snapshot() inspect(i) pinLod(n) materialPool(bool) setCamera(...)');
document.getElementById('clear').addEventListener('click', () => {
  for (const p of proxies) p.dispose();
  proxies.clear();
});
document.getElementById('target-fps').addEventListener('change', (e) => {
  pool.targetFps = +e.target.value;
});
document.getElementById('byte-budget').addEventListener('change', (e) => {
  pool.byteBudget = +e.target.value * 1024 * 1024;
});

// Phase 5: Interactive knob controls
// 3-LOD system: slider maps [0, 1, 2] to [null, 2, 4] (representing LODs [0, 2, 4])
// Value 0 = no ceiling (null), Value 1 = ceiling LOD 2, Value 2 = ceiling LOD 4
document.getElementById('ceiling-lod').addEventListener('input', (e) => {
  const sliderVal = +e.target.value;
  // Map slider value to actual LOD ceiling in 3-LOD system
  const lodMap = [null, 2, 4]; // slider 0 -> null (no ceiling), 1 -> LOD 2, 2 -> LOD 4
  pool.ceilingLod = lodMap[sliderVal];

  // Display LOD label instead of numeric value
  const lodLabels = ['unlimited', 'LOD 0/2', 'LOD 0'];
  document.getElementById('ceiling-value').textContent = lodLabels[sliderVal];
});
document.getElementById('mid-px').addEventListener('input', (e) => {
  const val = +e.target.value;
  pool.midPx = val;
  document.getElementById('mid-px-value').textContent = val;
});
document.getElementById('hero-cap').addEventListener('input', (e) => {
  const val = +e.target.value;
  pool.heroCap = val;
  document.getElementById('hero-cap-value').textContent = val;
});
document.getElementById('frustum-interval').addEventListener('input', (e) => {
  const val = +e.target.value;
  if (val === 0) {
    pool.frustumCheckInterval = 0; // Enable automatic dynamic calculation
    document.getElementById('frustum-interval-value').textContent = 'auto';
  } else {
    // Force fixed interval for testing (1-10 frames)
    pool._frustumCheckInterval = val;
    pool._dynamicFrustumCheckInterval = val;
    document.getElementById('frustum-interval-value').textContent = val;
  }
});

// Feature toggles
document.getElementById('frustum-cull').addEventListener('change', (e) => {
  pool._enableFrustumCulling = e.target.checked;
});
document.getElementById('texture-lod').addEventListener('change', (e) => {
  pool._enableTextureLod = e.target.checked;
});
document.getElementById('anim-throttle').addEventListener('change', (e) => {
  pool._enableAnimThrottle = e.target.checked;
});

// Material Grouping Optimization toggle
const materialPoolToggle = document.getElementById('material-pool');
if (materialPoolToggle) {
  materialPoolToggle.addEventListener('change', (e) => {
    pool._globalMaterialPool._useGlobalMaterialPool = e.target.checked;
    console.log('[Material Pool]', e.target.checked ? 'enabled' : 'disabled');
  });
}

// Asset Streaming: Deferred loading toggle
const deferredStreamingToggle = document.getElementById('deferred-streaming');
if (deferredStreamingToggle) {
  deferredStreamingToggle.addEventListener('change', (e) => {
    pool._enableDeferredStreaming = e.target.checked;
    console.log('[Deferred Streaming]', e.target.checked ? 'enabled' : 'disabled');
  });
}

// Multi-draw optimization toggle
const multiDrawToggle = document.getElementById('multi-draw');
if (multiDrawToggle) {
  multiDrawToggle.addEventListener('change', (e) => {
    pool._enableMultiDraw = e.target.checked;
    console.log('[Multi-Draw]', e.target.checked ? 'enabled' : 'disabled');
  });
}

// Frame-time breakdown chart
const frameHistory = [];
const maxFrameHistory = 60;
const frameCanvas = document.getElementById('frame-canvas');
const ctx = frameCanvas.getContext('2d');
let recordingTrace = false;
let traceData = [];
let traceStartTime = 0;

function drawFrameChart() {
  const w = frameCanvas.width;
  const h = frameCanvas.height;
  const barW = Math.max(2, Math.floor(w / maxFrameHistory));
  const padding = 2;

  ctx.fillStyle = '#1a1a20';
  ctx.fillRect(0, 0, w, h);

  // Draw grid
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5);
  ctx.lineTo(w, h * 0.5);
  ctx.stroke();

  // Draw frame bars
  let maxMs = 16.7;
  for (const frame of frameHistory) {
    maxMs = Math.max(maxMs, frame.total);
  }

  for (let i = 0; i < frameHistory.length; i++) {
    const frame = frameHistory[i];
    const x = i * (barW + padding);
    const scale = h / maxMs;

    let y = h;
    // Frustum time (red)
    const frustumH = frame.frustum * scale;
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(x, y - frustumH, barW, frustumH);
    y -= frustumH;

    // Entities time (yellow)
    const entitiesH = frame.entities * scale;
    ctx.fillStyle = '#ffd93d';
    ctx.fillRect(x, y - entitiesH, barW, entitiesH);
    y -= entitiesH;

    // Budget time (green)
    const budgetH = frame.budget * scale;
    ctx.fillStyle = '#6bcf7f';
    ctx.fillRect(x, y - budgetH, barW, budgetH);

    // Over-budget indicator
    if (frame.total > 16.7) {
      ctx.fillStyle = '#ff3333';
      ctx.fillRect(x, 0, barW, 2);
    }
  }

  // Labels
  ctx.fillStyle = '#999';
  ctx.font = '10px sans-serif';
  ctx.fillText(`${maxMs.toFixed(1)}ms`, 2, 10);
  ctx.fillText('16.7ms', 2, h - 5);
}

document.getElementById('export-btn').addEventListener('click', () => {
  if (recordingTrace) {
    // Stop recording and download
    recordingTrace = false;
    const csv = ['timestamp,fps,frustum,entities,budget,total,ceiling,midPx,heroCap,memory,visible'];
    for (const row of traceData) {
      csv.push(Object.values(row).join(','));
    }
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `profile-${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById('export-btn').textContent = 'export trace (30s)';
    document.getElementById('export-btn').style.background = '#445';
  } else {
    // Start recording
    recordingTrace = true;
    traceData = [];
    traceStartTime = performance.now();
    document.getElementById('export-btn').textContent = 'stop & export (REC)';
    document.getElementById('export-btn').style.background = '#ff5555';
  }
});

// Retarget ~3% of entities per frame to a fresh random nearby position over a
// 600-1400ms ease. Touching only a sparse subset each frame is the whole point:
// CPU work is O(subset) while ALL in-flight entities keep lerping on the GPU/CPU
// active set inside the pool. Demonstrates "fully capable of position updates".
let _moverScratch = [];
function _driveMovers() {
  const ents = _moverScratch;
  ents.length = 0;
  for (const e of pool._entities) { if (!e._disposed) ents.push(e); }
  if (!ents.length) return;
  const n = Math.max(1, Math.round(ents.length * 0.03));
  for (let i = 0; i < n; i++) {
    const e = ents[(Math.random() * ents.length) | 0];
    const base = e.root.position;
    const tx = base.x + (Math.random() - 0.5) * 4;
    const ty = Math.max(0, base.y + (Math.random() - 0.5) * 1.5);
    const tz = base.z + (Math.random() - 0.5) * 4;
    pool.setTarget(e, tx, ty, tz, 600 + Math.random() * 800);
  }
}

let orbitT = 0;
let zoomPhase = 0;
let _prevCamX = Infinity, _prevCamY = 0, _prevCamZ = 0;
let _poolUpdateCounter = 0;
function tick() {
  if (document.getElementById('orbit-cam').checked) {
    orbitT += 0.003;
    // Fly-through path: when zoom-cycle is on we pulse from far (r=60) to
    // very close (r=3, INSIDE the crowd) so all three tiers get exercised.
    // The HERO tier needs r<10 to see entities at >200 screen-px.
    let r = 30;
    if (document.getElementById('zoom-cycle').checked) {
      zoomPhase += 0.008;
      // 3..60 — sweep through the crowd, getting up close mid-cycle.
      r = 30 + Math.cos(zoomPhase) * 27;
    }
    camera.position.x = Math.cos(orbitT) * r;
    camera.position.z = Math.sin(orbitT) * r;
    camera.position.y = 6 + Math.sin(orbitT * 0.7) * 4;
    camera.lookAt(0, 1, 0);
  }
  // Throttle pool.update() (LOD/tier/frustum reevaluation) to every 3rd frame
  // for a static scene — but ALWAYS run it the frame the camera moved so LOD
  // still reacts to the view. renderer.render() stays every frame; instance
  // matrices persist between updates, so nothing visually freezes beyond a LOD
  // reevaluation cadence of ~20Hz.
  const cp = camera.position;
  const camMoved = Math.abs(cp.x - _prevCamX) > 1e-3 || Math.abs(cp.y - _prevCamY) > 1e-3 || Math.abs(cp.z - _prevCamZ) > 1e-3;
  _prevCamX = cp.x; _prevCamY = cp.y; _prevCamZ = cp.z;
  // Position-update demo: each frame retarget a SMALL random subset of entities
  // (proving O(updated) CPU cost) while the pool lerps every active mover on its
  // side. The interpolation makes them drift smoothly to new targets.
  const moversOn = document.getElementById('movers') && document.getElementById('movers').checked;
  if (moversOn) _driveMovers();
  // Movers (or a moving camera) need update() every frame for smooth motion;
  // a fully static scene can keep the 3rd-frame throttle.
  if (camMoved || moversOn || (_poolUpdateCounter++ % 3) === 0) {
    pool.update();
  }
  renderer.render(scene, camera);
  // renderer.info.autoReset is off; reset once per frame after rendering so the
  // HUD's draw-call/triangle counts reflect exactly one frame.
  renderer.info.reset();
  // HUD + frame-chart are diagnostics only — rebuilding the big innerHTML string
  // and redrawing the chart every frame causes layout/paint churn. Throttle to
  // ~10Hz (every 6th frame); rendering itself stays at full rate.
  if (!window.__hudCounter) window.__hudCounter = 0;
  if (window.__hudCounter++ < 6) { requestAnimationFrame(tick); return; }
  window.__hudCounter = 0;
  const s = pool.getStats();
  const memoryMB = s.bytes / 1024 / 1024;
  const estimatedVramMB = pool._estimatedVramMB;
  const memoryRatio = (s.bytes / (estimatedVramMB * 1024 * 1024)) * 100;
  // Color coding: green <50%, yellow 50-70%, red >70%
  const memoryColor = memoryRatio > 70 ? '#ff6b6b' : memoryRatio > 50 ? '#ffd93d' : '#6bcf7f';
  const memoryStatus = memoryRatio > 70 ? 'CRITICAL' : memoryRatio > 50 ? 'WARNING' : 'SAFE';
  // VRAM gauge: visual representation
  const gaugeWidth = 150;
  const gaugeFillWidth = Math.min(gaugeWidth, Math.max(0, (memoryRatio / 100) * gaugeWidth));
  const gaugeHTML = `<div style="display:inline-block;width:${gaugeWidth}px;height:12px;border:1px solid #666;background:#222;position:relative;vertical-align:middle;margin:0 4px;">
    <div style="width:${gaugeFillWidth}px;height:100%;background:${memoryColor};transition:width 0.2s;"></div>
    <div style="position:absolute;left:5px;top:0;color:#aaa;font-size:9px;line-height:12px;z-index:10;">${memoryRatio.toFixed(0)}%</div>
  </div>`;

  // Track frame metrics for chart
  const frameData = {
    frustum: s.msFrustum || 0,
    entities: s.msEntities || 0,
    budget: s.msBudget || 0,
    total: (s.msTotal || 0),
  };
  frameHistory.push(frameData);
  if (frameHistory.length > maxFrameHistory) frameHistory.shift();
  drawFrameChart();

  // Record profiling data if tracing
  if (recordingTrace) {
    const elapsed = (performance.now() - traceStartTime) / 1000;
    if (elapsed < 30) {
      traceData.push({
        timestamp: elapsed.toFixed(2),
        fps: s.fps.toFixed(1),
        frustum: (s.msFrustum || 0).toFixed(3),
        entities: (s.msEntities || 0).toFixed(3),
        budget: (s.msBudget || 0).toFixed(3),
        total: (s.msTotal || 0).toFixed(3),
        ceiling: pool.ceilingLod ?? 'null',
        midPx: pool.midPx.toFixed(0),
        heroCap: pool.heroCap,
        memory: memoryRatio.toFixed(1),
        visible: s.entities,
      });
    } else {
      recordingTrace = false;
      const csv = ['timestamp,fps,frustum,entities,budget,total,ceiling,midPx,heroCap,memory,visible'];
      for (const row of traceData) {
        csv.push(Object.values(row).join(','));
      }
      const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `profile-${new Date().toISOString().slice(0, 19)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      document.getElementById('export-btn').textContent = 'export trace (30s)';
      document.getElementById('export-btn').style.background = '#445';
    }
  }

  // Asset Streaming stats
  let deferredStats = '';
  if (pool._enableDeferredStreaming && s.deferredLoading) {
    const dl = s.deferredLoading;
    deferredStats = `<b>Deferred</b> queued ${dl.queued} inFlight ${dl.inFlight} loaded ${dl.totalLoaded} (${dl.avgLoadTimeMs}ms avg)<br>`;
  }
  if (pool._enableDeferredStreaming && s.unloadManager) {
    const um = s.unloadManager;
    deferredStats += `<b>Unload</b> visible ${um.visibleEntities} invisible ${um.invisibleEntities} VRAM ${um.estimatedVramMB}/${um.vramBudgetMB}MB<br>`;
  }

  // Multi-draw status
  let multiDrawStatus = '';
  if (pool._multiDrawOptimizer) {
    const md = s.multiDraw;
    const mdMethod = md.method === 'ANGLE_multi_draw' ? 'ANGLE' : md.method === 'OES_draw_elements_base_vertex' ? 'BaseVtx' : 'fallback';
    multiDrawStatus = `<b>multi-draw</b> ${mdMethod} reduced ${md.drawCallsReduced||0} calls<br>`;
  }

  hud.innerHTML = `
    <b>FPS</b> ${s.fps.toFixed(1)} (target ${pool.targetFps})<br>
    <b>entities</b> ${s.entities} <span class="tier">HERO ${s.hero||0} MID ${s.mid||0} FAR ${s.far||0}</span><br>
    <b>HERO budget</b> ${s.heroBudgetMs||0}ms/${pool._heroBudgetMs.toFixed(1)}ms <b>HERO dist</b> ${s.heroDist||0}m<br>
    <b>MID budget</b> ${s.midBudgetMs||0}ms/${pool._midBudgetMs.toFixed(1)}ms <b>MID dist</b> ${s.midDist||0}m<br>
    ${deferredStats}
    ${multiDrawStatus}
    <b>draws</b> ${s.drawCalls} <b>ceiling</b> ${s.ceilingLod ?? 'none'} (3-LOD: 0/2/4) <b>midPx</b> ${pool.midPx.toFixed(0)} <b>heroCap</b> ${pool.heroCap}<br>
    <b>VRAM</b> ${gaugeHTML} <span style="color:${memoryColor}"><b>${memoryStatus}</b> ${memoryMB.toFixed(1)}/${estimatedVramMB.toFixed(0)} MB (${memoryRatio.toFixed(0)}%)</span><br>
    <b>assets</b> ${s.assets} <b>inFlight</b> ${s.inFlight}<br>
    <b>tri</b> ${(renderer.info.render.triangles/1000).toFixed(1)}k<br>
    <b>frustum interval</b> ${pool._dynamicFrustumCheckInterval} frames (${pool._lastFrameMovingCount} moving entities)<br>
    <b>pool.update</b> ${(s.msTotal||0).toFixed(2)}ms (frustum ${(s.msFrustum||0).toFixed(2)} entities ${(s.msEntities||0).toFixed(2)} budget ${(s.msBudget||0).toFixed(2)})
  `;
  requestAnimationFrame(tick);
}
tick();
