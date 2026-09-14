import * as THREE from 'three';
import { ModelPool } from '../../src/model-pool.js';
import { enableDrawCallBatching } from './draw-call-batching.js';

const _assetsParam = new URLSearchParams(location.search).get('assets');
const ASSET_HOST_DEFAULT = 'https://anentrypoint.github.io/assets/';
const ASSET_BASE = (!_assetsParam || _assetsParam === 'remote')
  ? ASSET_HOST_DEFAULT
  : (_assetsParam === 'local' ? null : (_assetsParam.endsWith('/') ? _assetsParam : _assetsParam + '/'));

let ASSET_DIRS = [];
const ASSET_DIRS_READY = (ASSET_BASE === null
  ? fetch('/assets-list.json').then((r) => r.json())
      .then((list) => list.map((p) => (typeof p === 'string' ? p : p.path)))
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
renderer.sortObjects = false;
renderer.info.autoReset = false;
const scene = new THREE.Scene();
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
  maxConcurrentFetches: 32,
  useBatchedFarTier: true,
  useImpostorFinalLod: new URLSearchParams(location.search).get('impostor') === '1',
  impostorPx: Number(new URLSearchParams(location.search).get('impostorPx')) || 14,
  impostorCellBudget: Number(new URLSearchParams(location.search).get('impostorCellBudget')) || undefined,
  impostorTextureSize: Number(new URLSearchParams(location.search).get('impostorTextureSize')) || undefined,
  impostorMaxAssets: Number(new URLSearchParams(location.search).get('impostorMaxAssets')) || undefined,
  impostorHemiOcta: new URLSearchParams(location.search).get('impostorHemiOcta') === '1',
  impostorFade: new URLSearchParams(location.search).get('impostorFade') === '1',
});
window.__pool = pool;

if (!pool._useBatchedFarTier) enableDrawCallBatching(pool);

const proxies = new Set();

async function spawnUnique(n) {
  await ASSET_DIRS_READY;
  if (!ASSET_DIRS.length) {
    console.error('[stress] no assets available to spawn');
    return;
  }
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
async function spawnAll() {
  await ASSET_DIRS_READY;
  const n = ASSET_DIRS.length;
  if (!n) { console.error('[stress] no assets to spawn'); return 0; }
  const wantBudgetMB = Math.min(4096, Math.max(256, Math.ceil(n * 3)));
  pool.byteBudget = wantBudgetMB * 1024 * 1024;
  const bb = document.getElementById('byte-budget');
  if (bb) bb.value = wantBudgetMB;
  if (pool._lodUnloadManager) {
    pool._lodUnloadManager.vramBudgetMB = wantBudgetMB;
    pool._lodUnloadManager.vramBudgetBytes = wantBudgetMB * 1024 * 1024;
  }
  console.log(`[stress] spawning ALL ${n} distinct models, byteBudget=${wantBudgetMB}MB (unload budget raised)`);
  await spawnUnique(n);
  return n;
}
document.getElementById('spawn-all').addEventListener('click', spawnAll);

function _entityResolved(e) {
  if (!e || e._disposed) return false;
  for (const tm of e.trackedMeshes || []) {
    if (tm._instancedSlot && tm._instancedSlotIdx >= 0) return true;
    const g = tm.mesh && tm.mesh.geometry;
    if (tm.mesh && tm.mesh.visible !== false && g && g.attributes && g.attributes.position && g.attributes.position.count > 0) return true;
  }
  return false;
}
window.THREE = THREE;
window.__debug = {
  pool, scene, camera, renderer, proxies, THREE,
  spawnAll, clear: () => { for (const p of proxies) p.dispose(); proxies.clear(); },
  spawn: (n) => spawnUnique(n),
  setCamera(x, y, z, tx = 0, ty = 0, tz = 0) {
    camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld();
    return { pos: [x, y, z], target: [tx, ty, tz] };
  },
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
  materialPool(on) { pool._globalMaterialPool._useGlobalMaterialPool = !!on; return on; },
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
  pinLod(n) { pool._currentCeilingLod = n; pool.ceilingLod = n; return n; },
  unpinLod() { pool._currentCeilingLod = null; return null; },
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

document.getElementById('ceiling-lod').addEventListener('input', (e) => {
  const sliderVal = +e.target.value;
  const lodMap = [null, 2, 4];
  pool.ceilingLod = lodMap[sliderVal];

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
    pool.frustumCheckInterval = 0;
    document.getElementById('frustum-interval-value').textContent = 'auto';
  } else {
    pool._frustumCheckInterval = val;
    pool._dynamicFrustumCheckInterval = val;
    document.getElementById('frustum-interval-value').textContent = val;
  }
});

document.getElementById('frustum-cull').addEventListener('change', (e) => {
  pool._enableFrustumCulling = e.target.checked;
});
document.getElementById('texture-lod').addEventListener('change', (e) => {
  pool._enableTextureLod = e.target.checked;
});
document.getElementById('anim-throttle').addEventListener('change', (e) => {
  pool._enableAnimThrottle = e.target.checked;
});

const materialPoolToggle = document.getElementById('material-pool');
if (materialPoolToggle) {
  materialPoolToggle.addEventListener('change', (e) => {
    pool._globalMaterialPool._useGlobalMaterialPool = e.target.checked;
    console.log('[Material Pool]', e.target.checked ? 'enabled' : 'disabled');
  });
}

const deferredStreamingToggle = document.getElementById('deferred-streaming');
if (deferredStreamingToggle) {
  deferredStreamingToggle.addEventListener('change', (e) => {
    pool._enableDeferredStreaming = e.target.checked;
    console.log('[Deferred Streaming]', e.target.checked ? 'enabled' : 'disabled');
  });
}

const multiDrawToggle = document.getElementById('multi-draw');
if (multiDrawToggle) {
  multiDrawToggle.addEventListener('change', (e) => {
    pool._enableMultiDraw = e.target.checked;
    console.log('[Multi-Draw]', e.target.checked ? 'enabled' : 'disabled');
  });
}

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

  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5);
  ctx.lineTo(w, h * 0.5);
  ctx.stroke();

  let maxMs = 16.7;
  for (const frame of frameHistory) {
    maxMs = Math.max(maxMs, frame.total);
  }

  for (let i = 0; i < frameHistory.length; i++) {
    const frame = frameHistory[i];
    const x = i * (barW + padding);
    const scale = h / maxMs;

    let y = h;
    const frustumH = frame.frustum * scale;
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(x, y - frustumH, barW, frustumH);
    y -= frustumH;

    const entitiesH = frame.entities * scale;
    ctx.fillStyle = '#ffd93d';
    ctx.fillRect(x, y - entitiesH, barW, entitiesH);
    y -= entitiesH;

    const budgetH = frame.budget * scale;
    ctx.fillStyle = '#6bcf7f';
    ctx.fillRect(x, y - budgetH, barW, budgetH);

    if (frame.total > 16.7) {
      ctx.fillStyle = '#ff3333';
      ctx.fillRect(x, 0, barW, 2);
    }
  }

  ctx.fillStyle = '#999';
  ctx.font = '10px sans-serif';
  ctx.fillText(`${maxMs.toFixed(1)}ms`, 2, 10);
  ctx.fillText('16.7ms', 2, h - 5);
}

document.getElementById('export-btn').addEventListener('click', () => {
  if (recordingTrace) {
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
    recordingTrace = true;
    traceData = [];
    traceStartTime = performance.now();
    document.getElementById('export-btn').textContent = 'stop & export (REC)';
    document.getElementById('export-btn').style.background = '#ff5555';
  }
});

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
    let r = 30;
    if (document.getElementById('zoom-cycle').checked) {
      zoomPhase += 0.008;
      r = 30 + Math.cos(zoomPhase) * 27;
    }
    camera.position.x = Math.cos(orbitT) * r;
    camera.position.z = Math.sin(orbitT) * r;
    camera.position.y = 6 + Math.sin(orbitT * 0.7) * 4;
    camera.lookAt(0, 1, 0);
  }
  const cp = camera.position;
  const camMoved = Math.abs(cp.x - _prevCamX) > 1e-3 || Math.abs(cp.y - _prevCamY) > 1e-3 || Math.abs(cp.z - _prevCamZ) > 1e-3;
  _prevCamX = cp.x; _prevCamY = cp.y; _prevCamZ = cp.z;
  const moversOn = document.getElementById('movers') && document.getElementById('movers').checked;
  if (moversOn) _driveMovers();
  if (camMoved || moversOn || (_poolUpdateCounter++ % 3) === 0) {
    pool.update();
  }
  renderer.render(scene, camera);
  renderer.info.reset();
  if (!window.__hudCounter) window.__hudCounter = 0;
  if (window.__hudCounter++ < 6) { requestAnimationFrame(tick); return; }
  window.__hudCounter = 0;
  const s = pool.getStats();
  const memoryMB = s.bytes / 1024 / 1024;
  const estimatedVramMB = pool._estimatedVramMB;
  const memoryRatio = (s.bytes / (estimatedVramMB * 1024 * 1024)) * 100;
  const memoryColor = memoryRatio > 70 ? '#ff6b6b' : memoryRatio > 50 ? '#ffd93d' : '#6bcf7f';
  const memoryStatus = memoryRatio > 70 ? 'CRITICAL' : memoryRatio > 50 ? 'WARNING' : 'SAFE';
  const gaugeWidth = 150;
  const gaugeFillWidth = Math.min(gaugeWidth, Math.max(0, (memoryRatio / 100) * gaugeWidth));
  const gaugeHTML = `<div style="display:inline-block;width:${gaugeWidth}px;height:12px;border:1px solid #666;background:#222;position:relative;vertical-align:middle;margin:0 4px;">
    <div style="width:${gaugeFillWidth}px;height:100%;background:${memoryColor};transition:width 0.2s;"></div>
    <div style="position:absolute;left:5px;top:0;color:#aaa;font-size:9px;line-height:12px;z-index:10;">${memoryRatio.toFixed(0)}%</div>
  </div>`;

  const frameData = {
    frustum: s.msFrustum || 0,
    entities: s.msEntities || 0,
    budget: s.msBudget || 0,
    total: (s.msTotal || 0),
  };
  frameHistory.push(frameData);
  if (frameHistory.length > maxFrameHistory) frameHistory.shift();
  drawFrameChart();

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

  let deferredStats = '';
  if (pool._enableDeferredStreaming && s.deferredLoading) {
    const dl = s.deferredLoading;
    deferredStats = `<b>Deferred</b> queued ${dl.queued} inFlight ${dl.inFlight} loaded ${dl.totalLoaded} (${dl.avgLoadTimeMs}ms avg)<br>`;
  }
  if (pool._enableDeferredStreaming && s.unloadManager) {
    const um = s.unloadManager;
    deferredStats += `<b>Unload</b> visible ${um.visibleEntities} invisible ${um.invisibleEntities} VRAM ${um.estimatedVramMB}/${um.vramBudgetMB}MB<br>`;
  }

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
