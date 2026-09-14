import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';
import { bakeTransmittanceLUT, LUT_WIDTH, LUT_HEIGHT } from './atmosphere-transmittance-lut.js';
import { bakeScatteringLUT, SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS } from './atmosphere-scattering-lut.js';
import { canDecodeImages, decodeSurfaceTextureSet } from './surface-texture-decode.js';

import { TU, M4 } from './gl-render-mat4.js';

let _sharedRawTransLUT = null
let _sharedRawScatLUT = null
let _sharedSurfaceTexDecode = null
const SHADER_CACHE_TAG = 'ms-0.1.264'
const DESIGN_RADIUS_M = 6360000.0
const HORIZON_SPHERE_DEPTH_BELOW_SEA = 150.0
const SUBMERGED_FAR_REACH = 60000.0
const FXC_UNROLL_DEFEAT_LOOP_BOUND = 64
const DIST_SORT_BUCKETS = 256
const DIST_SORT_MAX_BUCKET = DIST_SORT_BUCKETS - 1
const WATER_HIDDEN_AFTER_EMPTY_QUERIES = 2
const WATER_PROBE_MIN_RELIABLE_ALT_M = 5.0
const WATER_WINDING_FLIP_ALT_M = 5.0
function _startLutBakeWorker() {
  try {
    if (typeof Worker === 'undefined') return null
    const w = new Worker(new URL('./atmosphere-lut-worker.js', import.meta.url), { type: 'module' })
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (done) return; done = true; try { w.terminate() } catch (_) {} resolve(v) }
      w.onmessage = (ev) => { const d = ev.data; finish((d && d.ok && d.trans && d.scat) ? { trans: d.trans, scat: d.scat } : null) }
      w.onerror = () => finish(null)
      w.onmessageerror = () => finish(null)
      w.postMessage({})
    })
  } catch (_) { return null }
}
function _startSurfaceDecodeWorker() {
  try {
    if (typeof Worker === 'undefined') return null
    const w = new Worker(new URL('./surface-texture-worker.js', import.meta.url), { type: 'module' })
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (done) return; done = true; try { w.terminate() } catch (_) {} resolve(v) }
      w.onmessage = (ev) => { const d = ev.data; finish((d && d.ok && d.albAll && d.nrmAll) ? d : null) }
      w.onerror = () => finish(null)
      w.onmessageerror = () => finish(null)
      w.postMessage({ baseUrl: new URL('../textures/', import.meta.url).href })
    })
  } catch (_) { return null }
}

export async function initMapspinnerRender(gl, opts = {}) {
  if (opts.radius != null && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
    throw new TypeError(`mapspinner: opts.radius must be a positive finite number, got ${opts.radius}`);
  }
  if (opts.gridMeshSize != null && (!Number.isInteger(opts.gridMeshSize) || opts.gridMeshSize < 2)) {
    throw new TypeError(`mapspinner: opts.gridMeshSize must be an integer >= 2, got ${opts.gridMeshSize}`);
  }
  const R = opts.radius || 6360.0;
  const TILE_W = opts.tileW || 25;
  const GRID = opts.gridMeshSize || TD.gridMeshSize;
  if (typeof window !== 'undefined') window.__glGrid = GRID;
  const BORDER = 2;
  const USABLE = TILE_W - 2*BORDER;

  let _hpfTex = null, _hpfTex2 = null;
  const bakeOnly = !!opts.bakeOnly;

  const _shaderNoCache = (typeof window !== 'undefined' && window.__shaderNoCache === true);
  const _sv = _shaderNoCache
    ? '?v=' + (typeof performance !== 'undefined' ? (performance.now()|0) : Date.now())
    : '?v=' + SHADER_CACHE_TAG;
  const _fetchOpts = _shaderNoCache ? { cache: 'reload' } : { cache: 'no-cache' };
  const _lutJob = (!bakeOnly && !_sharedRawTransLUT) ? _startLutBakeWorker() : null;
  const _fetchText = (rel) => fetch(new URL(rel + _sv, import.meta.url), _fetchOpts).then(r => r.text());
  let [src, atmoSrc] = await Promise.all([
    _fetchText('./shaders/terrain.glsl'),
    bakeOnly ? Promise.resolve('') : _fetchText('./shaders/atmosphere.glsl'),
  ]);

  const _parExt = gl.getExtension('KHR_parallel_shader_compile');
  const COMPLETION_STATUS_KHR = 0x91B1;
  async function awaitProgramLink(p, vs, fs, label){
    const yield_ = () => new Promise(res => (typeof requestAnimationFrame !== 'undefined'
      && typeof document !== 'undefined' && !document.hidden
      ? requestAnimationFrame(() => res()) : setTimeout(res, 8)));
    if (_parExt) {
      while (!gl.getProgramParameter(p, COMPLETION_STATUS_KHR)) { await yield_(); }
    } else {
      await yield_();
    }
    if (vs && !gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(label+' vs: '+gl.getShaderInfoLog(vs));
    if (fs && !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(label+' fs: '+gl.getShaderInfoLog(fs));
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(label+' link: '+gl.getProgramInfoLog(p));
  }
  const hdr = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2DArray;\n';
  function buildTerrainProgram(terrainSrc, atmo, fsDefs, sharedVs){
    fsDefs = fsDefs || '';
    function shader(type, def){ const s=gl.createShader(type);
      const body = (type===gl.FRAGMENT_SHADER) ? (atmo+'\n'+terrainSrc) : terrainSrc;
      const tokens = [def].concat(
        (type===gl.FRAGMENT_SHADER && fsDefs) ? fsDefs.trim().split(/\s+/) : []);
      const defLines = tokens.map(t => '#define '+t+'\n').join('');
      gl.shaderSource(s, hdr+defLines+body); gl.compileShader(s); return s; }
    const vs = sharedVs || shader(gl.VERTEX_SHADER,'_VERTEX_'), fs = shader(gl.FRAGMENT_SHADER,'_FRAGMENT_');
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'vertex');
    gl.linkProgram(p);
    return { p, vs, fs };
  }
  let _b = bakeOnly ? null : buildTerrainProgram(src, atmoSrc);
  let _bw = bakeOnly ? null : buildTerrainProgram(src, atmoSrc, ' _WATERPASS_', _b.vs);
  let _curVs = _b ? _b.vs : null;
  if (!bakeOnly) {
    await awaitProgramLink(_b.p, _b.vs, _b.fs, 'terrain');
    await awaitProgramLink(_bw.p, null, _bw.fs, 'water');
  }
  let prog = _b ? _b.p : null;
  let waterProg = _bw ? _bw.p : null;
  const _wUloc = new Map();
  let debugProg = null, _dbgBuilding = null;
  const _dbgUloc = new Map();
  const DEBUG_MODES = new Set([1,5,6,7,8,9,10,11,12]);
  function ensureDebug(){
    if (debugProg || _dbgBuilding) return;
    if (typeof window !== 'undefined') window.__debugProgState = 'compiling';
    _dbgBuilding = (async () => {
      try {
        const nb = buildTerrainProgram(src, atmoSrc, ' _DEBUGVIEW_', _curVs);
        await awaitProgramLink(nb.p, null, nb.fs, 'debug');
        debugProg = nb.p; _dbgUloc.clear(); _chuClear(_chuD);
        if (typeof window !== 'undefined') window.__debugProgState = 'ready';
      } catch(e){ try { if(typeof window!=='undefined') { window.__debugProgErr = String(e.message||e); window.__debugProgState = 'failed: ' + String(e.message||e).slice(0,120); } } catch(_){} }
      finally { _dbgBuilding = null; }
    })();
  }
  let _activeProg = null, _activeUloc = null, _activeChu = null;
  function setActiveProgram(p, cache, chu){ _activeProg = p; _activeUloc = cache; _activeChu = chu; }
  const _uloc = new Map();
  const U = n => { const cache = _activeUloc || _uloc; const p = _activeProg || prog;
    let l = cache.get(n); if (l === undefined) { l = gl.getUniformLocation(p, n); cache.set(n, l); } return l; };
  let _probeUloc = new Map();
  const PU = n => { let l = _probeUloc.get(n); if (l === undefined) { l = gl.getUniformLocation(probeProg, n); _probeUloc.set(n, l); } return l; };
  async function recompile(){
    try {
      if (bakeOnly) throw new Error('recompile() unavailable on a bakeOnly instance');
      const _t = '?t=' + (performance.now()|0);
      const [ns, na] = await Promise.all([
        fetch(new URL('./shaders/terrain.glsl' + _t, import.meta.url), { cache: 'reload' }).then(r => r.text()),
        fetch(new URL('./shaders/atmosphere.glsl' + _t, import.meta.url), { cache: 'reload' }).then(r => r.text()),
      ]);
      const nb = buildTerrainProgram(ns, na);
      const nbw = buildTerrainProgram(ns, na, ' _WATERPASS_', nb.vs);
      await awaitProgramLink(nb.p, nb.vs, nb.fs, 'terrain');
      await awaitProgramLink(nbw.p, null, nbw.fs, 'water');
      const newProg = nb.p;
      const old = prog, oldW = waterProg; prog = newProg; waterProg = nbw.p; _curVs = nb.vs; src = ns; atmoSrc = na;
      _uloc.clear(); _chuClear(_chuR); _wUloc.clear(); _chuClear(_chuW);
      gl.deleteProgram(old); gl.deleteProgram(oldW);
      if (debugProg) { gl.deleteProgram(debugProg); debugProg = null; _dbgUloc.clear(); _chuClear(_chuD); }
      if (probeProg) { gl.deleteProgram(probeProg); probeProg = null; _probeUloc.clear(); _chuClear(_chuP); }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  let probeProg = null, probeFbo = null, probeTex = null, _probeBuilding = null;
  function ensureProbe(){
    if (probeProg || _probeBuilding) return;
    _probeBuilding = (async () => {
      try {
        const pvs = hdr + 'void main(){ gl_Position = vec4(0.0,0.0,0.0,1.0); gl_PointSize = 1.0; }';
        const pfs = hdr + atmoSrc + '\n#define _PROBE_\n' + src;
        const pv = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(pv, pvs); gl.compileShader(pv);
        const pf = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(pf, pfs); gl.compileShader(pf);
        const pp = gl.createProgram(); gl.attachShader(pp, pv); gl.attachShader(pp, pf); gl.linkProgram(pp);
        await awaitProgramLink(pp, pv, pf, 'probe');
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 1, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        _probeUloc.clear(); _chuClear(_chuP);
        probeTex = tex; probeFbo = fbo; probeProg = pp;
      } catch(e){ probeProg = null; try { if(typeof window!=='undefined') window.__probeErr = String(e.message||e); } catch(_){} }
      finally { _probeBuilding = null; }
    })();
  }
  const probeVao = gl.createVertexArray();
  let _probePbo = null, _probeSync = null, _probeLastM = null;
  const _probeOut = new Float32Array(1);
  const _probeSyncOut = new Float32Array(1);
  function _drawProbeIntoFbo(dir){
    const pl = Math.hypot(dir[0],dir[1],dir[2])||1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
    gl.viewport(0,0,1,1);
    gl.useProgram(probeProg);
    gl.bindVertexArray(probeVao);
    _octClampAlt = 0;
    setComposeHeightUniforms(PU, _chuP);
    _chuSet1f(PU, _chuP, 'defRadius', R);
    gl.uniform3f(PU('probeDir'), dir[0]/pl, dir[1]/pl, dir[2]/pl);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.POINTS, 0, 1);
  }
  function _releaseProbeFbo(){
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }
  function _issueProbeDraw(dir){
    if (!_probePbo) { _probePbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    _drawProbeIntoFbo(dir);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo);
    gl.readPixels(0,0,1,1, gl.RED, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    _releaseProbeFbo();
  }
  function _readProbePbo(){
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _probePbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, _probeOut);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    _probeLastM = _probeOut[0];
  }
  function sampleGroundM(dir) {
    if (!probeProg) { ensureProbe(); return null; }
    if (_probeSync) {
      const st = gl.clientWaitSync(_probeSync, 0, 0);
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return _probeLastM;
      _readProbePbo();
      gl.deleteSync(_probeSync); _probeSync = null;
    }
    _issueProbeDraw(dir);
    _probeSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return _probeLastM;
  }
  function sampleGroundMSync(dir) {
    if (!probeProg) { ensureProbe(); return null; }
    _drawProbeIntoFbo(dir);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.readPixels(0,0,1,1, gl.RED, gl.FLOAT, _probeSyncOut);
    _releaseProbeFbo();
    return _probeSyncOut[0];
  }

  const THC_BAKE_RES = 130;
  const _faceFrames = [
    [0,0,-1, 0,1,0, 1,0,0], [0,0,1, 0,1,0, -1,0,0],
    [1,0,0, 0,0,-1, 0,1,0], [1,0,0, 0,0,1, 0,-1,0],
    [1,0,0, 0,1,0, 0,0,1], [-1,0,0, 0,1,0, 0,0,-1],
  ];
  const _faceFramesF32 = _faceFrames.map(f => new Float32Array(f));
  let bakeProg=null, bakeTex=null, bakeFbo=null, _bakeBuilding=null; const _bakeUloc=new Map();
  const BU = n => { let l=_bakeUloc.get(n); if(l===undefined){ l=gl.getUniformLocation(bakeProg,n); _bakeUloc.set(n,l);} return l; };
  function ensureBake(){
    if (bakeProg || _bakeBuilding) return;
    _bakeBuilding = (async () => {
      try {
        const bvs = hdr + 'void main(){ vec2 p=vec2((gl_VertexID==1)?3.0:-1.0,(gl_VertexID==2)?3.0:-1.0); gl_Position=vec4(p,0.0,1.0); }';
        const bfs = hdr + '\n#define _HEIGHTBAKE_\n' + src;
        const bv=gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(bv,bvs); gl.compileShader(bv);
        const bf=gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(bf,bfs); gl.compileShader(bf);
        const bp=gl.createProgram(); gl.attachShader(bp,bv); gl.attachShader(bp,bf); gl.linkProgram(bp);
        await awaitProgramLink(bp, bv, bf, 'bake');
        const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, THC_BAKE_RES, THC_BAKE_RES);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        _bakeUloc.clear(); _chuClear(_chuB); bakeTex=tex; bakeFbo=fbo; bakeProg=bp;
      } catch(e){ bakeProg=null; try{ if(typeof window!=='undefined') window.__bakeErr=String(e.message||e); }catch(_){} }
      finally { _bakeBuilding=null; }
    })();
  }
  const bakeVao = gl.createVertexArray();
  let _bakePbo = null;
  function drawBakeTile(face, ox, oy, l, level){
    gl.viewport(0,0,THC_BAKE_RES,THC_BAKE_RES);
    gl.useProgram(bakeProg);
    gl.bindVertexArray(bakeVao);
    _octClampAlt = 0;
    setComposeHeightUniforms(BU, _chuB);
    gl.uniform1f(BU('defRadius'), R);
    gl.uniformMatrix3fv(BU('uBakeFrame'), false, _faceFramesF32[face|0]);
    gl.uniform4f(BU('uBakeOffset'), ox, oy, l, level);
    gl.uniform1f(BU('uBakeRes'), THC_BAKE_RES);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function bakeTileReadback(face, ox, oy, l, level){
    if (!bakeProg){ ensureBake(); return null; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
    drawBakeTile(face, ox, oy, l, level);
    const byteLen = THC_BAKE_RES*THC_BAKE_RES*4;
    if (!_bakePbo) _bakePbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, _bakePbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);
    gl.readPixels(0,0,THC_BAKE_RES,THC_BAKE_RES, gl.RED, gl.FLOAT, 0);
    const out = new Float32Array(byteLen / 4);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    let dbg=null;
    if (typeof window !== 'undefined' && window.__glCheck) {
      try{ dbg={ offLoc: BU('uBakeOffset')!=null, resLoc: BU('uBakeRes')!=null, frameLoc: BU('uBakeFrame')!=null,
        offRead: BU('uBakeOffset')?Array.from(gl.getUniform(bakeProg, BU('uBakeOffset'))):null,
        resRead: BU('uBakeRes')?gl.getUniform(bakeProg, BU('uBakeRes')):null }; }catch(e){ dbg={err:String(e)}; }
    }
    return { heights: out, res: THC_BAKE_RES, dbg };
  }
  const BAKE_ASYNC_SLOTS = 4;
  const _bakeAsyncSlots = Array.from({ length: BAKE_ASYNC_SLOTS }, () => ({ pbo: null, fence: null, pending: null }));
  function bakeTileIssueAsync(face, ox, oy, l, level, deferFlush){
    if (!bakeProg){ ensureBake(); return false; }
    const slot = _bakeAsyncSlots.find(s => !s.fence);
    if (!slot) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
    drawBakeTile(face, ox, oy, l, level);
    const byteLen = THC_BAKE_RES*THC_BAKE_RES*4;
    if (!slot.pbo) slot.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);
    gl.readPixels(0,0,THC_BAKE_RES,THC_BAKE_RES, gl.RED, gl.FLOAT, 0);
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!deferFlush) gl.flush();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    slot.pending = { face, ox, oy, l, level };
    return true;
  }
  function bakeFlush(){ gl.flush(); }
  function bakeTilePollAsync(){
    for (const slot of _bakeAsyncSlots) {
      if (!slot.fence) continue;
      const status = gl.clientWaitSync(slot.fence, 0, 0);
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) continue;
      gl.deleteSync(slot.fence); slot.fence = null;
      const byteLen = THC_BAKE_RES*THC_BAKE_RES*4;
      const out = new Float32Array(byteLen / 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const meta = slot.pending; slot.pending = null;
      return { heights: out, res: THC_BAKE_RES, face: meta.face, ox: meta.ox, oy: meta.oy, l: meta.l, level: meta.level };
    }
    return null;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.__thcBakeReadback = bakeTileReadback; globalThis.__thcEnsureBake = ensureBake;
    globalThis.__thcBakeIssueAsync = bakeTileIssueAsync; globalThis.__thcBakePollAsync = bakeTilePollAsync;
    globalThis.__thcBakeFlush = bakeFlush;
  }

  const THC_POOL_LAYERS = 512;
  let heightPool=null, poolFbo=null;
  const _tcMap = new Map();
  const _tcLayerKey = new Array(THC_POOL_LAYERS).fill(null);
  const _tcUsed = new Int32Array(THC_POOL_LAYERS);
  let _tcFrame = 0, _tcNextFree = 0, _tcBakesThisFrame = 0;
  function invalidatePool(){ _tcMap.clear(); _tcLayerKey.fill(null); _tcNextFree = 0; }
  function ensurePool(){
    if (heightPool) return;
    heightPool = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, heightPool);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, THC_BAKE_RES, THC_BAKE_RES, THC_POOL_LAYERS);
    const lin = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, lin); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    poolFbo = gl.createFramebuffer();
  }
  function bakeTileToLayer(face,ox,oy,l,level,layer){
    gl.bindFramebuffer(gl.FRAMEBUFFER, poolFbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, heightPool, 0, layer);
    drawBakeTile(face, ox, oy, l, level);
    _tcBakesThisFrame++;
  }
  function ensureTileLayer(face,ox,oy,l,level){
    const key = face+':'+ox+':'+oy+':'+l;
    let layer = _tcMap.get(key);
    if (layer === undefined){
      if (_tcNextFree < THC_POOL_LAYERS){ layer = _tcNextFree++; }
      else { let lru=0, lruF=_tcUsed[0]; for(let k=1;k<THC_POOL_LAYERS;k++) if(_tcUsed[k]<lruF){lruF=_tcUsed[k];lru=k;} layer=lru; const old=_tcLayerKey[lru]; if(old!=null) _tcMap.delete(old); }
      _tcMap.set(key, layer); _tcLayerKey[layer]=key;
      bakeTileToLayer(face,ox,oy,l,level,layer);
    }
    _tcUsed[layer]=_tcFrame;
    return layer;
  }
  let _tcInvSeen = 0;
  function thcActive(){
    if (typeof window==='undefined' || !window.__thc) return false;
    if (!bakeProg){ ensureBake(); return false; }
    ensurePool();
    const inv = (window.__thcInval|0);
    if (inv !== _tcInvSeen){ _tcInvSeen = inv; invalidatePool(); }
    return !!heightPool;
  }
  if (typeof window !== 'undefined') window.__thcInvalidate = () => { window.__thcInval = (window.__thcInval|0) + 1; };

  const _halfFloatLinearOK = !!gl.getExtension('OES_texture_float_linear') || !!gl.getExtension('OES_texture_half_float_linear');
  try { if (typeof window !== 'undefined') window.__terrainConfig = { floatLinearOK: _halfFloatLinearOK }; } catch(_){}

  let _octClampAlt = 0;
  function _clampOcts(baseOcts) {
    if (typeof window !== 'undefined' && window.__altOctClamp === false) return baseOcts;
    const altKm = _octClampAlt / 1000.0;
    let drop = 0;
    if (altKm > 2000)      drop = 6;
    else if (altKm > 800)  drop = 4;
    else if (altKm > 200)  drop = 2;
    else if (altKm > 80)   drop = 1;
    return Math.max(6, baseOcts - drop);
  }
  const _chuR = Object.create(null);
  const _chuW = Object.create(null);
  const _chuD = Object.create(null);
  const _chuP = Object.create(null);
  const _chuB = Object.create(null);
  const _chuS = Object.create(null);
  function _chuClear(chu){ for (const k in chu) delete chu[k]; }
  const _wkeys = Object.create(null);
  const _wkey = (n) => _wkeys[n] || (_wkeys[n] = '__' + n);
  const _g = (n, d) => { if (typeof window === 'undefined') return d; const v = window[_wkey(n)]; return v != null ? +v : d; };
  let _dummyShadowTex = null;
  function ensureDummyShadowTex() {
    if (_dummyShadowTex) return _dummyShadowTex;
    _dummyShadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _dummyShadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _dummyShadowTex;
  }
  let _dummyHeightPoolTex = null;
  function ensureDummyHeightPoolTex() {
    if (_dummyHeightPoolTex) return _dummyHeightPoolTex;
    _dummyHeightPoolTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _dummyHeightPoolTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, 1, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return _dummyHeightPoolTex;
  }
  const SCULPT_RES = 256;
  let _sculptTex = null, _dummySculptTex = null;
  function withTexture2DOnScratchUnit(tex, work) {
    const activeUnitBefore = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE15);
    const scratchBindingBefore = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { work(); } finally {
      gl.bindTexture(gl.TEXTURE_2D, scratchBindingBefore);
      gl.activeTexture(activeUnitBefore);
    }
  }
  function createR32FTexture(size, filter) {
    const tex = gl.createTexture();
    withTexture2DOnScratchUnit(tex, () => {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    return tex;
  }
  function ensureSculptTex() {
    if (!_sculptTex) _sculptTex = createR32FTexture(SCULPT_RES, _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST);
    return _sculptTex;
  }
  function ensureDummySculptTex() {
    if (!_dummySculptTex) _dummySculptTex = createR32FTexture(1, gl.NEAREST);
    return _dummySculptTex;
  }
  let _sculptState = null;
  function setSculptOverride(center, extent, frameBasis, heights) {
    if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !Number.isFinite(extent) || extent <= 0 || !frameBasis) { _sculptState = null; return; }
    _sculptState = { center: [center[0], center[1]], extent, up: frameBasis.up, east: frameBasis.east, north: frameBasis.north };
    if (heights) {
      withTexture2DOnScratchUnit(ensureSculptTex(), () => {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SCULPT_RES, SCULPT_RES, gl.RED, gl.FLOAT, heights);
      });
    }
  }
  function clearSculptOverride() { _sculptState = null; }
  let _dummySurfTex = null;
  function ensureDummySurfTex() {
    if (_dummySurfTex) return _dummySurfTex;
    _dummySurfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _dummySurfTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return _dummySurfTex;
  }
  let _dummySceneTex = null;
  function ensureDummySceneTex() {
    if (_dummySceneTex) return _dummySceneTex;
    _dummySceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _dummySceneTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _dummySceneTex;
  }
  let _lutTex = null;
  let _rawTransLUT = null;
  function ensureTransmittanceLUT() {
    if (_lutTex) return _lutTex;
    if (!_sharedRawTransLUT) {
      if (typeof window !== 'undefined') window.__lutBakeCount = (window.__lutBakeCount || 0) + 1;
      _sharedRawTransLUT = bakeTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT);
    }
    const { data, width, height } = _sharedRawTransLUT;
    _rawTransLUT = { data, width, height };
    const dataRGBA = new Float32Array(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
      dataRGBA[i*4] = data[i*3]; dataRGBA[i*4+1] = data[i*3+1]; dataRGBA[i*4+2] = data[i*3+2]; dataRGBA[i*4+3] = 1.0;
    }
    _lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _lutTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, dataRGBA);
    const lin = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    try { if (typeof window !== 'undefined') window.__atmLutBaked = { width, height, floatLinearOK: _halfFloatLinearOK, tex: _lutTex }; } catch(_){}
    return _lutTex;
  }
  let _scatTex = null;
  function ensureScatteringLUT() {
    if (_scatTex) return _scatTex;
    ensureTransmittanceLUT();
    if (!_sharedRawScatLUT) {
      _sharedRawScatLUT = bakeScatteringLUT(SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS, undefined, _rawTransLUT);
    }
    const { data, width, height, layers } = _sharedRawScatLUT;
    _scatTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _scatTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, width, height, layers);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, width, height, layers, gl.RGBA, gl.FLOAT, data);
    const lin = _halfFloatLinearOK ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    try { if (typeof window !== 'undefined') window.__atmScatteringLutBaked = { width, height, layers, floatLinearOK: _halfFloatLinearOK, tex: _scatTex }; } catch(_){}
    return _scatTex;
  }
  if (_lutJob) {
    const r = await _lutJob;
    if (r) {
      if (!_sharedRawTransLUT) _sharedRawTransLUT = r.trans;
      if (!_sharedRawScatLUT) _sharedRawScatLUT = r.scat;
      if (typeof window !== 'undefined') window.__atmLutWorkerUsed = true;
    } else if (typeof window !== 'undefined') window.__atmLutWorkerUsed = false;
  }
  if (!bakeOnly) {
    ensureTransmittanceLUT();
    ensureScatteringLUT();
  }
  function _chuSet1f(loc, chu, name, v){
    if (chu[name] === v) return;
    chu[name] = v; gl.uniform1f(loc(name), v);
  }
  function _chuSet1i(loc, chu, name, v){
    if (chu[name] === v) return;
    chu[name] = v; gl.uniform1i(loc(name), v);
  }
  function _chuSet2f(loc, chu, name, x, y){
    const prev = chu[name];
    if (prev !== undefined) { if (prev[0] === x && prev[1] === y) return; prev[0] = x; prev[1] = y; }
    else chu[name] = [x,y];
    gl.uniform2f(loc(name), x, y);
  }
  function _chuSet3f(loc, chu, name, x, y, z){
    const prev = chu[name];
    if (prev !== undefined) { if (prev[0] === x && prev[1] === y && prev[2] === z) return; prev[0] = x; prev[1] = y; prev[2] = z; }
    else chu[name] = [x,y,z];
    gl.uniform3f(loc(name), x, y, z);
  }
  function _chuSet4f(loc, chu, name, x, y, z, w){
    const prev = chu[name];
    if (prev !== undefined) { if (prev[0] === x && prev[1] === y && prev[2] === z && prev[3] === w) return; prev[0] = x; prev[1] = y; prev[2] = z; prev[3] = w; }
    else chu[name] = [x,y,z,w];
    gl.uniform4f(loc(name), x, y, z, w);
  }
  function _chuSetM4(loc, chu, name, m){
    const prev = chu[name];
    if (prev !== undefined) {
      let same = true; for (let i = 0; i < 16; i++) if (prev[i] !== m[i]) { same = false; break; }
      if (same) return;
      prev.set(m);
    } else chu[name] = new Float32Array(m);
    gl.uniformMatrix4fv(loc(name), false, m);
  }
  function setComposeHeightUniforms(loc, cacheKey) {
    const g = _g;
    _chuSet1f(loc, cacheKey, 'uHiFreqCut',     g('hiFreqCut', TD.hiFreqCut));
    _chuSet1f(loc, cacheKey, 'uDetailOverlay', g('detailOverlay', TD.detailOverlay));
    _chuSet1f(loc, cacheKey, 'canyonDepthMul', g('canyonDepth', TD.canyonDepth));
    _chuSet1f(loc, cacheKey, 'uVsCheap',       (typeof window!=='undefined' && window.__vsCheap) ? 1.0 : 0.0);
    _chuSet1f(loc, cacheKey, 'uBeachShelfM',   g('beachShelf', TD.beachShelf));
    _chuSet1f(loc, cacheKey, 'uLandBias',      g('landBias', TD.landBias));
    _chuSet1f(loc, cacheKey, 'cliffAmt',       g('cliffAmt', TD.cliffAmt));
    _chuSet1i(loc, cacheKey, 'uFloatLinearOK', _halfFloatLinearOK ? 1 : 0);
    _chuSet1i(loc, cacheKey, 'uOctMax',        (typeof window!=='undefined' && window.__octMax!=null) ? (window.__octMax|0) : _clampOcts(12));
    _chuSet1i(loc, cacheKey, 'uNoUnroll',      FXC_UNROLL_DEFEAT_LOOP_BOUND);
    _chuSet1i(loc, cacheKey, 'uInciseRidgeOcts', (typeof window!=='undefined' && window.__inciseRidgeOcts!=null) ? (window.__inciseRidgeOcts|0) : 4);
    _chuSet1i(loc, cacheKey, 'uBroadLowOcts',    (typeof window!=='undefined' && window.__broadLowOcts!=null) ? (window.__broadLowOcts|0) : 2);
    _chuSet1i(loc, cacheKey, 'uPeakOcts',        (typeof window!=='undefined' && window.__peakOcts!=null) ? (window.__peakOcts|0) : 3);
    _chuSet1i(loc, cacheKey, 'uDetailFbmOcts',   (typeof window!=='undefined' && window.__detailFbmOcts!=null) ? (window.__detailFbmOcts|0) : 3);
    _chuSet1i(loc, cacheKey, 'uFSDetailOcts',    (typeof window!=='undefined' && window.__fsDetailOcts!=null) ? (window.__fsDetailOcts|0) : 3);
    _chuSet1f(loc, cacheKey, 'uNrmStepM',      g('nrmStepM', 300.0));
    _chuSet1f(loc, cacheKey, 'uGrid',          GRID);
    _chuSet1f(loc, cacheKey, 'uHpfInset',      (typeof window!=='undefined' && window.__hpfInset === false) ? 0.0 : 1.0);
    _chuSet1f(loc, cacheKey, 'uMtnBandWide',   g('mtnBandWide', TD.mtnBandWide));
    _chuSet1f(loc, cacheKey, 'uClimateRelief', g('climateRelief', TD.climateRelief));
    _chuSet1f(loc, cacheKey, 'uIsleWide',      g('isleWide', TD.isleWide));
    _chuSet1f(loc, cacheKey, 'uCarveWide',     g('carveWide', TD.carveWide));
    _chuSet1f(loc, cacheKey, 'uReliefScale',   g('reliefScale', opts.reliefScale != null ? opts.reliefScale : R / 63600000.0));
    const sc = _sculptState;
    _chuSet1f(loc, cacheKey, 'uSculptActive', sc ? 1.0 : 0.0);
    if (sc) {
      _chuSet3f(loc, cacheKey, 'uSculptUp',    sc.up[0], sc.up[1], sc.up[2]);
      _chuSet3f(loc, cacheKey, 'uSculptEast',  sc.east[0], sc.east[1], sc.east[2]);
      _chuSet3f(loc, cacheKey, 'uSculptNorth', sc.north[0], sc.north[1], sc.north[2]);
      _chuSet2f(loc, cacheKey, 'uSculptCenter', sc.center[0], sc.center[1]);
      _chuSet1f(loc, cacheKey, 'uSculptExtent', sc.extent);
    }
    _chuSet1i(loc, cacheKey, 'uSculptOverride', TU.sculptOverride);
    gl.activeTexture(gl.TEXTURE0 + TU.sculptOverride);
    gl.bindTexture(gl.TEXTURE_2D, sc ? ensureSculptTex() : ensureDummySculptTex());
  }


  let _surfAlb = null, _surfNrm = null, _surfMeanL = [0.2, 0.2, 0.2, 0.5];
  async function _decodeSurfaceTextures() {
    const w = _startSurfaceDecodeWorker();
    const r = w ? await w : null;
    if (typeof window !== 'undefined') window.__surfTexWorkerUsed = !!r;
    return r || await decodeSurfaceTextureSet(new URL('../textures/', import.meta.url).href);
  }

  async function loadSurfaceTextures() {
    if (!_sharedSurfaceTexDecode) _sharedSurfaceTexDecode = _decodeSurfaceTextures();
    const { albAll, nrmAll, meanL, rockMean, matCount, sz } = await _sharedSurfaceTexDecode;
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    async function mkArray(data, internal) {
      const t = gl.createTexture();
      const _prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 11, internal, sz, sz, matCount);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      for (let m = 0; m < matCount; m++) {
        if (m > 0) { await new Promise(res => setTimeout(res, 0)); gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); }
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, m, sz, sz, 1, gl.RGBA, gl.UNSIGNED_BYTE, data, m * sz * sz * 4);
      }
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.activeTexture(_prevActiveUnit);
      return t;
    }
    _surfMeanL = meanL;
    if (typeof window !== 'undefined') { window.__surfMeanL = meanL; window.__surfRockMean = rockMean; }
    const _alb = await mkArray(albAll, gl.SRGB8_ALPHA8);
    const _nrm = await mkArray(nrmAll, gl.RGBA8);
    _surfAlb = _alb; _surfNrm = _nrm;
    if (typeof window !== 'undefined') window.__surfTexReady = true;
  }
  if (!bakeOnly && canDecodeImages()) {
    loadSurfaceTextures().catch(e => { try { if (typeof window !== 'undefined') window.__surfTexErr = String(e.message || e); else if (typeof self !== 'undefined') self.__surfTexErr = String(e.message || e); } catch (_) {} });
  }

  const skyVsSrc = hdr + `out vec2 vNdc;
    void main(){ vec2 p = vec2((gl_VertexID==1)?3.0:-1.0, (gl_VertexID==2)?3.0:-1.0);
      vNdc = p; gl_Position = vec4(p, 1.0, 1.0); }`;
  const skyFsSrc = hdr + atmoSrc + `
    in vec2 vNdc;
    layout(location=0) out vec4 fragColor;
    uniform mat3 camRot;
    uniform vec2 projDiag;
    uniform vec3 skyCamWorld;
    uniform vec3 skySunDir;
    uniform float skyR;
    uniform float uSkyFade;
    uniform float uSkyDbg;
    void main(){
      vec3 dirView = normalize(vec3(vNdc.x/projDiag.x, vNdc.y/projDiag.y, -1.0));
      vec3 viewRay = normalize(camRot * dirView);
      vec3 camAtm = atmPos(skyCamWorld, skyR);
      vec3 t;
      vec3 radiance = atm_skyRadiance(camAtm, viewRay, skySunDir, t);

      {
        float rc = length(camAtm);
        float muc = dot(camAtm, viewRay) / rc;
        float b = rc * sqrt(max(1.0 - muc*muc, 0.0));
        float halo = 0.0;
        if (muc < 0.0) {
          float t0 = (b - ATM_BOTTOM) / (ATM_TOP - ATM_BOTTOM);
          halo = smoothstep(0.0, 0.06, t0) * (1.0 - smoothstep(0.25, 1.6, t0));
        }
        vec3 limbDir = normalize(camAtm + viewRay * (-rc*muc));
        float lit = 0.25 + 0.75 * smoothstep(-0.5, 0.6, dot(limbDir, skySunDir));
        vec3 haloColor = vec3(0.32, 0.55, 1.0);
        radiance += haloColor * (halo * lit) * 0.03;
      }
      float cosVS = dot(viewRay, skySunDir);
      if (cosVS > cos(ATM_SUN_ANGULAR_RADIUS)) {
        radiance += t * ATM_SOLAR_IRRADIANCE * 6.0;
      }
      float sunElevDot = clamp(dot(skySunDir, normalize(skyCamWorld)), 0.0, 1.0);
      float skyExposure = mix(48.0, 14.0, sunElevDot);
      vec3 c = radiance * vec3(0.82, 0.95, 1.22) * skyExposure;
      vec3 mapped = clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14), 0.0, 1.0);
      float skyLum = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
      mapped = clamp(mix(vec3(skyLum), mapped, 1.3), 0.0, 1.0);
      if (uSkyDbg > 0.5) {
        vec3 dbg = radiance;
        if (uSkyDbg < 1.5) dbg = radiance;
        else if (uSkyDbg < 2.5) dbg = c;
        else if (uSkyDbg < 3.5) dbg = mapped;
        fragColor = vec4(dbg, 1.0);
        return;
      }
      fragColor = vec4(pow(mapped, vec3(1.0/2.2)) * uSkyFade, 1.0);
    }`;
  function rawShader(type, source){ const s=gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error('sky '+type+': '+gl.getShaderInfoLog(s)); return s; }
  let skyProg = null, skyVao = null;
  const _usloc = new Map();
  const SU = n => { let l = _usloc.get(n); if (l === undefined) { l = gl.getUniformLocation(skyProg, n); _usloc.set(n, l); } return l; };
  if (!bakeOnly) {
  skyProg = gl.createProgram();
  gl.attachShader(skyProg, rawShader(gl.VERTEX_SHADER, skyVsSrc));
  gl.attachShader(skyProg, rawShader(gl.FRAGMENT_SHADER, skyFsSrc));
  gl.linkProgram(skyProg);
  if(!gl.getProgramParameter(skyProg, gl.LINK_STATUS)) throw new Error('sky link: '+gl.getProgramInfoLog(skyProg));
  skyVao = gl.createVertexArray();
  gl.useProgram(skyProg);
  const skyTransLoc = gl.getUniformLocation(skyProg, 'uTransmittanceLUT');
  if (skyTransLoc) gl.uniform1i(skyTransLoc, TU.transmittanceLUT);
  const skyScatLoc = gl.getUniformLocation(skyProg, 'uScatteringLUT');
  if (skyScatLoc) gl.uniform1i(skyScatLoc, TU.scatteringLUT);
  }

  const upVsSrc = '#version 300 es\nprecision highp float;\nout vec2 vUv;\nvoid main(){ vec2 p=vec2((gl_VertexID==1)?3.0:-1.0,(gl_VertexID==2)?3.0:-1.0); vUv=p*0.5+0.5; gl_Position=vec4(p,0.0,1.0); }';
  const upFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform vec2 uUvScale;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){ fragColor=texture(uTex, vUv*uUvScale); }';
  let upProg = null, upUTex = null, upUScale = null;
  if (!bakeOnly) {
  upProg = gl.createProgram();
  gl.attachShader(upProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(upProg, rawShader(gl.FRAGMENT_SHADER, upFsSrc));
  gl.linkProgram(upProg);
  if(!gl.getProgramParameter(upProg, gl.LINK_STATUS)) throw new Error('upscale link: '+gl.getProgramInfoLog(upProg));
  upUTex = gl.getUniformLocation(upProg, 'uTex');
  upUScale = gl.getUniformLocation(upProg, 'uUvScale');
  }
  const dwFsSrc = '#version 300 es\nprecision highp float;\nuniform highp sampler2D uDepth;\nuniform float uDepthEps;\nuniform vec2 uUvScale;\nuniform float uSrcNear;\nuniform float uSrcFar;\nuniform float uDstNear;\nuniform float uDstFar;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  float zNdcSrc = texture(uDepth, vUv*uUvScale).r * 2.0 - 1.0;\n  float zEye = (2.0*uSrcNear*uSrcFar) / (uSrcFar+uSrcNear - zNdcSrc*(uSrcFar-uSrcNear));\n  float projB = (uDstFar*uDstNear) / (uDstFar-uDstNear);\n  float biasM = (projB > 0.0) ? (uDepthEps * zEye * zEye / projB) : 0.0;\n  float zEyeBiased = zEye + biasM;\n  float zNdcDst = (uDstFar+uDstNear)/(uDstFar-uDstNear) + (1.0/zEyeBiased)*((-2.0*uDstFar*uDstNear)/(uDstFar-uDstNear));\n  float depth01 = clamp(zNdcDst * 0.5 + 0.5, 0.0, 1.0);\n  gl_FragDepth = depth01;\n  fragColor = vec4(0.0);\n}';
  let dwProg = null, dwUDepth = null, dwUBias = null, dwUScale = null, dwUSrcNear = null, dwUSrcFar = null, dwUDstNear = null, dwUDstFar = null;
  const udwFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform highp sampler2D uDepth;\nuniform float uDepthEps;\nuniform vec2 uUvScale;\nuniform float uSrcNear;\nuniform float uSrcFar;\nuniform float uDstNear;\nuniform float uDstFar;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  float zNdcSrc = texture(uDepth, vUv*uUvScale).r * 2.0 - 1.0;\n  float zEye = (2.0*uSrcNear*uSrcFar) / (uSrcFar+uSrcNear - zNdcSrc*(uSrcFar-uSrcNear));\n  float projB = (uDstFar*uDstNear) / (uDstFar-uDstNear);\n  float biasM = (projB > 0.0) ? (uDepthEps * zEye * zEye / projB) : 0.0;\n  float zEyeBiased = zEye + biasM;\n  float zNdcDst = (uDstFar+uDstNear)/(uDstFar-uDstNear) + (1.0/zEyeBiased)*((-2.0*uDstFar*uDstNear)/(uDstFar-uDstNear));\n  float depth01 = clamp(zNdcDst * 0.5 + 0.5, 0.0, 1.0);\n  gl_FragDepth = depth01;\n  fragColor = texture(uTex, vUv*uUvScale);\n}';
  let udwProg = null, udwUTex = null, udwUDepth = null, udwUBias = null, udwUScale = null, udwUSrcNear = null, udwUSrcFar = null, udwUDstNear = null, udwUDstFar = null;
  if (!bakeOnly) {
  dwProg = gl.createProgram();
  gl.attachShader(dwProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(dwProg, rawShader(gl.FRAGMENT_SHADER, dwFsSrc));
  gl.linkProgram(dwProg);
  dwUDepth = gl.getUniformLocation(dwProg, 'uDepth');
  dwUBias = gl.getUniformLocation(dwProg, 'uDepthEps');
  dwUScale = gl.getUniformLocation(dwProg, 'uUvScale');
  dwUSrcNear = gl.getUniformLocation(dwProg, 'uSrcNear');
  dwUSrcFar = gl.getUniformLocation(dwProg, 'uSrcFar');
  dwUDstNear = gl.getUniformLocation(dwProg, 'uDstNear');
  dwUDstFar = gl.getUniformLocation(dwProg, 'uDstFar');
  udwProg = gl.createProgram();
  gl.attachShader(udwProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(udwProg, rawShader(gl.FRAGMENT_SHADER, udwFsSrc));
  gl.linkProgram(udwProg);
  if(!gl.getProgramParameter(udwProg, gl.LINK_STATUS)) throw new Error('upscale+writeback link: '+gl.getProgramInfoLog(udwProg));
  udwUTex = gl.getUniformLocation(udwProg, 'uTex');
  udwUDepth = gl.getUniformLocation(udwProg, 'uDepth');
  udwUBias = gl.getUniformLocation(udwProg, 'uDepthEps');
  udwUScale = gl.getUniformLocation(udwProg, 'uUvScale');
  udwUSrcNear = gl.getUniformLocation(udwProg, 'uSrcNear');
  udwUSrcFar = gl.getUniformLocation(udwProg, 'uSrcFar');
  udwUDstNear = gl.getUniformLocation(udwProg, 'uDstNear');
  udwUDstFar = gl.getUniformLocation(udwProg, 'uDstFar');
  }
  const dpFsSrc = '#version 300 es\nprecision highp float;\nuniform highp sampler2D uDepth;\nuniform vec2 uUvScale;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  float z = texture(uDepth, vUv*uUvScale).r;\n  float hi = floor(z*255.0)/255.0;\n  float lo = fract(z*255.0);\n  fragColor = vec4(hi, lo, 0.0, 1.0);\n}';
  let dpProg = null, dpUTex = null, dpUScale = null;
  if (!bakeOnly) {
  dpProg = gl.createProgram();
  gl.attachShader(dpProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(dpProg, rawShader(gl.FRAGMENT_SHADER, dpFsSrc));
  gl.linkProgram(dpProg);
  dpUTex = gl.getUniformLocation(dpProg, 'uDepth');
  dpUScale = gl.getUniformLocation(dpProg, 'uUvScale');
  }
  let _dpFbo = null, _dpTex = null, _dpW = 0, _dpH = 0;
  const cmpUTex = upUTex;

  const easuFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform vec2 uUvScale;\nuniform vec2 uSrcTexel;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  vec2 uv = vUv*uUvScale;\n  vec2 texel = uSrcTexel*uUvScale;\n  vec3 center = texture(uTex, uv).rgb;\n  vec3 n = texture(uTex, uv + vec2(0.0, -texel.y)).rgb;\n  vec3 s = texture(uTex, uv + vec2(0.0,  texel.y)).rgb;\n  vec3 e = texture(uTex, uv + vec2( texel.x, 0.0)).rgb;\n  vec3 w = texture(uTex, uv + vec2(-texel.x, 0.0)).rgb;\n  float lc = dot(center, vec3(0.2126, 0.7152, 0.0722));\n  float ln = dot(n, vec3(0.2126, 0.7152, 0.0722));\n  float ls = dot(s, vec3(0.2126, 0.7152, 0.0722));\n  float le = dot(e, vec3(0.2126, 0.7152, 0.0722));\n  float lw = dot(w, vec3(0.2126, 0.7152, 0.0722));\n  float lmin = min(lc, min(min(ln, ls), min(le, lw)));\n  float lmax = max(lc, max(max(ln, ls), max(le, lw)));\n  float contrast = clamp((lmax - lmin) * 4.0, 0.0, 1.0);\n  vec3 dirAvg = (n + s + e + w) * 0.25;\n  vec3 sharp = center * (1.0 + contrast * 0.5) - dirAvg * (contrast * 0.5);\n  fragColor = vec4(mix(center, sharp, contrast), 1.0);\n}';
  let easuProg = null, easuUTex = null, easuUScale = null, easuUSrcTexel = null;
  if (!bakeOnly) {
  easuProg = gl.createProgram();
  gl.attachShader(easuProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(easuProg, rawShader(gl.FRAGMENT_SHADER, easuFsSrc));
  gl.linkProgram(easuProg);
  if(!gl.getProgramParameter(easuProg, gl.LINK_STATUS)) throw new Error('easu link: '+gl.getProgramInfoLog(easuProg));
  easuUTex = gl.getUniformLocation(easuProg, 'uTex');
  easuUScale = gl.getUniformLocation(easuProg, 'uUvScale');
  easuUSrcTexel = gl.getUniformLocation(easuProg, 'uSrcTexel');
  }
  const rcasFsSrc = '#version 300 es\nprecision highp float;\nuniform sampler2D uTex;\nuniform vec2 uTexel;\nuniform float uSharpness;\nin vec2 vUv;\nout vec4 fragColor;\nvoid main(){\n  vec2 uv = vUv;\n  vec3 c = texture(uTex, uv).rgb;\n  vec3 n = texture(uTex, uv + vec2(0.0, -uTexel.y)).rgb;\n  vec3 s = texture(uTex, uv + vec2(0.0,  uTexel.y)).rgb;\n  vec3 e = texture(uTex, uv + vec2( uTexel.x, 0.0)).rgb;\n  vec3 w = texture(uTex, uv + vec2(-uTexel.x, 0.0)).rgb;\n  vec3 mn4 = min(min(n, s), min(e, w));\n  vec3 mx4 = max(max(n, s), max(e, w));\n  vec3 mn = min(mn4, c);\n  vec3 mx = max(mx4, c);\n  vec3 reciprocalMx = 1.0 / max(mx, vec3(0.0001));\n  vec3 ampl = clamp(min(mn, vec3(2.0) - mx) * reciprocalMx, vec3(0.0), vec3(1.0));\n  ampl = sqrt(ampl);\n  vec3 w4 = ampl * mix(vec3(-0.125), vec3(-0.20), uSharpness);\n  vec3 numerator = w4 * (n + s + e + w) + c;\n  vec3 denominator = vec3(1.0) + 4.0 * w4;\n  vec3 result = numerator / denominator;\n  fragColor = vec4(clamp(result, 0.0, 4.0), 1.0);\n}';
  let rcasProg = null, rcasUTex = null, rcasUTexel = null, rcasUSharpness = null;
  if (!bakeOnly) {
  rcasProg = gl.createProgram();
  gl.attachShader(rcasProg, rawShader(gl.VERTEX_SHADER, upVsSrc));
  gl.attachShader(rcasProg, rawShader(gl.FRAGMENT_SHADER, rcasFsSrc));
  gl.linkProgram(rcasProg);
  if(!gl.getProgramParameter(rcasProg, gl.LINK_STATUS)) throw new Error('rcas link: '+gl.getProgramInfoLog(rcasProg));
  rcasUTex = gl.getUniformLocation(rcasProg, 'uTex');
  rcasUTexel = gl.getUniformLocation(rcasProg, 'uTexel');
  rcasUSharpness = gl.getUniformLocation(rcasProg, 'uSharpness');
  }
  let _fsr1UpTex = null, _fsr1UpFbo = null, _fsr1UpW = 0, _fsr1UpH = 0;
  function ensureFsr1UpTarget(W, H) {
    if (_fsr1UpTex && _fsr1UpW === W && _fsr1UpH === H) return;
    if (_fsr1UpTex) gl.deleteTexture(_fsr1UpTex);
    if (_fsr1UpFbo) gl.deleteFramebuffer(_fsr1UpFbo);
    _fsr1UpTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _fsr1UpTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _fsr1UpFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, _fsr1UpFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _fsr1UpTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    _fsr1UpW = W; _fsr1UpH = H;
  }
  const upVao = bakeOnly ? null : gl.createVertexArray();
  let _vdrsFbo = null, _vdrsColor = null, _vdrsDepth = null, _vdrsW = 0, _vdrsH = 0, _vdrsRsThisFrame = 0;
  let _sceneCopyTex = null, _sceneCopyW = 0, _sceneCopyH = 0;
  function ensureSceneCopy(W, H) {
    if (_sceneCopyTex && _sceneCopyW === W && _sceneCopyH === H) return;
    if (_sceneCopyTex) gl.deleteTexture(_sceneCopyTex);
    const _prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE15);
    _sceneCopyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _sceneCopyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(_prevActiveUnit);
    _sceneCopyW = W; _sceneCopyH = H;
  }
  let _hrwFbo=null, _hrwColor=null, _hrwDepth=null, _hrwW=0, _hrwH=0;
  function ensureHrwTargets(W, H){
    if (_hrwFbo && _hrwW===W && _hrwH===H) return;
    if (_hrwColor) gl.deleteTexture(_hrwColor);
    if (_hrwDepth) gl.deleteRenderbuffer(_hrwDepth);
    if (_hrwFbo)   gl.deleteFramebuffer(_hrwFbo);
    const _prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE15);
    _hrwColor=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,_hrwColor);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(_prevActiveUnit);
    _hrwDepth=gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER,_hrwDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,W,H);
    _hrwFbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,_hrwFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,_hrwColor,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,_hrwDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    _hrwW=W; _hrwH=H;
  }
  function ensureVdrsTargets(W, H){
    if (_vdrsFbo && _vdrsW === W && _vdrsH === H) return;
    if (_vdrsColor) gl.deleteTexture(_vdrsColor);
    if (_vdrsDepth) gl.deleteTexture(_vdrsDepth);
    if (_vdrsFbo)   gl.deleteFramebuffer(_vdrsFbo);
    const _prevActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE15);
    _vdrsColor = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    _vdrsDepth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, W, H, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _vdrsFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _vdrsColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, _vdrsDepth, 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.clearDepth(1.0); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(_prevActiveUnit);
    _vdrsW = W; _vdrsH = H;
  }

  const g2 = GRID+2;
  const n2 = g2+1;
  const du = 1.0/GRID;
  const vlist = [];
  for (let y=0;y<n2;y++) for (let x=0;x<n2;x++){
    const isRing = (x===0 || x===n2-1 || y===0 || y===n2-1);
    const px = Math.min(Math.max((x-1)*du, 0.0), 1.0);
    const py = Math.min(Math.max((y-1)*du, 0.0), 1.0);
    vlist.push(px, py, isRing ? 1.0 : 0.0);
  }
  const idx = [];
  for (let y=0;y<g2;y++) for (let x=0;x<g2;x++){
    const a=y*n2+x,b=a+1,c=a+n2,d=c+1;
    let h = (x | (y << 16)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0);
    h = h ^ (h >>> 16);
    if ((h >>> 17) & 1) idx.push(a,c,d, a,d,b);
    else                idx.push(a,c,b, b,c,d);
  }
  const verts = new Float32Array(vlist);
  const indices = new Uint32Array(idx);
  let vbo = null, ibo = null;
  if (!bakeOnly) {
    vbo=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,vbo); gl.bufferData(gl.ARRAY_BUFFER,verts,gl.STATIC_DRAW);
    ibo=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
  }

  const WGRID = (typeof window!=='undefined' && window.__waterGrid) ? window.__waterGrid : 4;
  const wg2 = WGRID+2, wn2 = wg2+1, wdu = 1.0/WGRID;
  const wvlist = [];
  for (let y=0;y<wn2;y++) for (let x=0;x<wn2;x++){
    const isRing=(x===0||x===wn2-1||y===0||y===wn2-1);
    wvlist.push(Math.min(Math.max((x-1)*wdu,0.0),1.0), Math.min(Math.max((y-1)*wdu,0.0),1.0), isRing?1.0:0.0);
  }
  const widx=[];
  for (let y=0;y<wg2;y++) for (let x=0;x<wg2;x++){ const a=y*wn2+x,b=a+1,c=a+wn2,d=c+1; widx.push(a,c,b,b,c,d); }
  const waterVerts=new Float32Array(wvlist), waterIndices=new Uint32Array(widx);
  let wvbo = null, wibo = null, instBuf = null;
  if (!bakeOnly) {
    wvbo=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,wvbo); gl.bufferData(gl.ARRAY_BUFFER,waterVerts,gl.STATIC_DRAW);
    wibo=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,wibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,waterIndices,gl.STATIC_DRAW);
    instBuf=gl.createBuffer();
  }
  const instBufWater = bakeOnly ? null : gl.createBuffer();
  let _instQuadsRef=null, _instWaterRef=null, _instWaterN=0, _lastThc=false;
  let _waterVisQ = null, _waterVisQPending = false, _waterVisZeroRuns = 0;
  let _scrD2 = new Float64Array(0), _scrOrd = new Int32Array(0), _scrInst = new Float32Array(0);
  let _scrWl = new Float32Array(0);
  function _ensureScratch(n, FLOATS) {
    if (_scrD2.length < n) _scrD2 = new Float64Array(n);
    if (_scrOrd.length < n) _scrOrd = new Int32Array(n);
    if (_scrInst.length < n * FLOATS) _scrInst = new Float32Array(n * FLOATS);
  }
  function _ensureWaterScratch(n, FLOATS) {
    if (_scrWl.length < n * FLOATS) _scrWl = new Float32Array(n * FLOATS);
  }
  const _waterSeen = new Set();
  const _camRotScratch = new Float32Array(9);

  function localToWorld3(face) {
    const F = [
      {c:[ 1,0,0], u:[0,0,-1], v:[0,1,0]},
      {c:[-1,0,0], u:[0,0, 1], v:[0,1,0]},
      {c:[0, 1,0], u:[1,0,0], v:[0,0,-1]},
      {c:[0,-1,0], u:[1,0,0], v:[0,0, 1]},
      {c:[0,0, 1], u:[1,0,0], v:[0,1,0]},
      {c:[0,0,-1], u:[-1,0,0],v:[0,1,0]},
    ][face];
    return new Float32Array([ F.u[0],F.u[1],F.u[2],  F.v[0],F.v[1],F.v[2],  F.c[0],F.c[1],F.c[2] ]);
  }

  function cullMatrix(cam, scalarsIn) {
    let aspect, near, far;
    if (scalarsIn) {
      aspect = scalarsIn.aspect; near = scalarsIn.near; far = scalarsIn.far;
    } else {
      aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const camDist = Math.hypot(cam.eye[0], cam.eye[1], cam.eye[2]);
      const alt = Math.max(0.0, camDist - R);
      const altAboveTerrain = Math.max(0.001, alt - R * (cam.surfElev || 0));
      const RHORIZON = R - HORIZON_SPHERE_DEPTH_BELOW_SEA;
      const horizon = (camDist > RHORIZON) ? Math.sqrt(camDist*camDist - RHORIZON*RHORIZON) : SUBMERGED_FAR_REACH;
      near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5);
      const _fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0));
      const farGround = Math.max(horizon, alt * 8.0);
      far = farGround * (1.0 - _fBlend) + camDist * _fBlend;
    }
    const eye = cam.eye;
    const proj = M4.perspective(cam.fovy||0.785, aspect, near, far, _cmProj);
    _cmCtr[0] = cam.center[0]-eye[0]; _cmCtr[1] = cam.center[1]-eye[1]; _cmCtr[2] = cam.center[2]-eye[2];
    const viewRel = M4.lookAt(_cmZero, _cmCtr, cam.up||_cmUpDefault, _cmView);
    _cmNegEye[0] = -eye[0]; _cmNegEye[1] = -eye[1]; _cmNegEye[2] = -eye[2];
    const viewProjNoEye = M4.mul(proj, viewRel, _cmPV);
    const viewProjRel = M4.mul(viewProjNoEye, M4.translate(_cmNegEye, _cmTrans), _cmVPR);
    const o = _cmOut;
    o.viewProjRel = viewProjRel; o.viewProjNoEye = viewProjNoEye; o.eye = eye; o.near = near; o.far = far; o.proj = proj; o.viewRel = viewRel;
    return o;
  }
  const _cmProj = new Float32Array(16), _cmView = new Float32Array(16), _cmTrans = new Float32Array(16), _cmPV = new Float32Array(16), _cmVPR = new Float32Array(16);
  const _cmZero = [0,0,0], _cmCtr = [0,0,0], _cmNegEye = [0,0,0], _cmUpDefault = [0,1,0];
  const _cmOut = { viewProjRel: null, viewProjNoEye: null, eye: null, near: 0, far: 0, proj: null, viewRel: null };

  const _passManifest = [
    { id: 'terrain-tile-draw', purpose: 'Instanced draw of all visible terrain quads (+ optional THC bake-on-sight)', reads: ['quads', 'viewProjRel', 'composeHeight uniforms'], writes: ['color', 'depth'] },
    { id: 'water-visibility-probe', purpose: 'Conservative occlusion query + shared-depth stamp for the half-res water gate', reads: ['depth'], writes: ['depth (stamp)', 'occlusion query result'] },
    { id: 'half-res-water-color', purpose: 'Half- or full-res water color pass (raymarched animated surface) + scene-copy refraction source', reads: ['color (scene copy)', 'depth'], writes: ['color', '_hrwColor (half-res target)'] },
    { id: 'water-depth-share', purpose: 'Depth-only re-draw of the water surface into _vdrsDepth so submerged consumer geometry is occluded', reads: ['water mesh'], writes: ['depth'] },
    { id: 'half-res-water-composite', purpose: 'Premultiplied-alpha upscale-composite of the half-res water color target onto the scene FBO', reads: ['_hrwColor'], writes: ['color'] },
    { id: 'upscale-to-canvas', purpose: 'VDRS fullscreen-quad LINEAR upscale of the flexed-viewport FBO color to the canvas', reads: ['_vdrsColor'], writes: ['canvas color'] },
    { id: 'planet-depth-writeback', purpose: 'Shader-pass re-encode + stamp of planet depth into the canvas depth buffer for a host consumer scene', reads: ['_vdrsDepth'], writes: ['canvas depth'] },
    { id: 'atmosphere-aerial-composite', purpose: 'Fullscreen sky/atmosphere pass (drawSky), depth-tested only when the bound framebuffer holds this frame real depth', reads: ['depth (conditional)'], writes: ['color'] },
  ];
  function getPassManifest() { return _passManifest.map(p => ({ ...p })); }
  if (typeof globalThis !== 'undefined') globalThis.__mapspinnerPassManifest = getPassManifest;

  const _F = {
    cam: null, sunDir: null, time: 0, eye: null,
    aspect: 1, near: 0, far: 0, alt: 0, camDist: 0, camAlt: 0,
    camDirX: 0, camDirY: 0, camDirZ: 0,
    cm: null, viewProjRel: null, viewProjNoEye: null,
    vW: 0, vH: 0, vrs: 0, bm: null,
  };
  const _C = (k, d) => (_F.bm && _F.bm[k]) ? _F.bm[k] : d;
  const _c3 = (n, d) => { const v = _C(n, d); _chuSet3f(U, _activeChu, n, v[0], v[1], v[2]); };
  const _o3 = (n, d) => { const w = (typeof window !== 'undefined' && window[_wkey(n)]) || null; const v = (Array.isArray(w) && w.length === 3) ? w : d; _chuSet3f(U, _activeChu, n, v[0], v[1], v[2]); };

  function drawSky(depthTested) {
    const camAlt = _F.camAlt, _cm = _F.cm, eye = _F.eye, sunDir = _F.sunDir;
    const skyFade = Math.max(0.0, 1.0 - camAlt / 100000.0);
    if (typeof window !== 'undefined' && window.__passProbe === true) {
      (window.__passProbeLog = window.__passProbeLog || []).push(
        'drawSky enter depthTested=' + depthTested + ' camAlt=' + camAlt.toFixed(1) + ' skyFade=' + skyFade.toFixed(4));
    }
    if (skyFade <= 0.001) {
      if (typeof window !== 'undefined' && window.__passProbe === true) (window.__passProbeLog = window.__passProbeLog || []).push('drawSky EARLY-RETURN skyFade<=0.001');
      return;
    }
    gl.useProgram(skyProg);
    _camRotScratch[0]=_cm.viewRel[0]; _camRotScratch[1]=_cm.viewRel[4]; _camRotScratch[2]=_cm.viewRel[8];
    _camRotScratch[3]=_cm.viewRel[1]; _camRotScratch[4]=_cm.viewRel[5]; _camRotScratch[5]=_cm.viewRel[9];
    _camRotScratch[6]=_cm.viewRel[2]; _camRotScratch[7]=_cm.viewRel[6]; _camRotScratch[8]=_cm.viewRel[10];
    gl.uniformMatrix3fv(SU('camRot'), false, _camRotScratch);
    _chuSet2f(SU, _chuS, 'projDiag', _cm.proj[0], _cm.proj[5]);
    gl.uniform3f(SU('skyCamWorld'), eye[0], eye[1], eye[2]);
    gl.uniform3f(SU('skySunDir'), sunDir[0], sunDir[1], sunDir[2]);
    _chuSet1f(SU, _chuS, 'skyR', R);
    gl.uniform1f(SU('uSkyFade'), skyFade);
    _chuSet1f(SU, _chuS, 'uSkyDbg', (typeof window!=='undefined' && window.__skyDbg) ? window.__skyDbg : 0.0);
    if (typeof window !== 'undefined' && window.__passProbeSkyNoDepth === true) depthTested = false;
    if (depthTested) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); }
    else { gl.disable(gl.DEPTH_TEST); }
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    if (typeof window !== 'undefined' && window.__passProbe === true) (window.__passProbeLog = window.__passProbeLog || []).push('drawSky exit drew fullscreen tri');
  }

  function _passProbeSnap(label, srcTex, texW, texH) {
    if (!(typeof window !== 'undefined' && window.__passProbe === true)) return;
    try {
      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevViewport = gl.getParameter(gl.VIEWPORT);
      const W = srcTex ? texW : gl.drawingBufferWidth, H = srcTex ? texH : gl.drawingBufferHeight;
      let fbo = null;
      if (srcTex) {
        fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          gl.deleteFramebuffer(fbo); gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo); return;
        }
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (srcTex) { gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo); gl.deleteFramebuffer(fbo); }
      else gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      const pw = 256, ph = Math.max(1, Math.round(256 * H / W));
      const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
      const cx = cv.getContext('2d');
      const img = cx.createImageData(pw, ph);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        const sx = Math.min(W - 1, Math.round(x * W / pw)), sy = H - 1 - Math.min(H - 1, Math.round(y * H / ph));
        const si = (sy * W + sx) * 4, di = (y * pw + x) * 4;
        img.data[di] = px[si]; img.data[di+1] = px[si+1]; img.data[di+2] = px[si+2]; img.data[di+3] = 255;
      }
      cx.putImageData(img, 0, 0);
      (window.__passProbeFrames = window.__passProbeFrames || []).push({ label, dataURL: cv.toDataURL('image/jpeg', 0.7) });
    } catch (e) {
      (window.__passProbeLog = window.__passProbeLog || []).push('_passProbeSnap ERR ' + label + ': ' + e);
    }
  }

  function passUpscaleToCanvas() {
    const _fsr1 = (typeof window !== 'undefined' && window.__vdrsUpscaleFsr1 === true);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(true);
    if (_fsr1) {
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      ensureFsr1UpTarget(W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, _fsr1UpFbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(easuProg);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor);
      gl.uniform1i(easuUTex, TU.upscale);
      gl.uniform2f(easuUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
      gl.uniform2f(easuUSrcTexel, _vdrsW > 0 ? 1 / _vdrsW : 0, _vdrsH > 0 ? 1 / _vdrsH : 0);
      gl.bindVertexArray(upVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(rcasProg);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _fsr1UpTex);
      gl.uniform1i(rcasUTex, TU.upscale);
      gl.uniform2f(rcasUTexel, 1 / W, 1 / H);
      gl.uniform1f(rcasUSharpness, (typeof window !== 'undefined' && typeof window.__vdrsUpscaleFsr1Sharpness === 'number') ? window.__vdrsUpscaleFsr1Sharpness : 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(upProg);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor);
      gl.uniform1i(upUTex, TU.upscale);
      gl.uniform2f(upUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
      gl.bindVertexArray(upVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.enable(gl.DEPTH_TEST);
  }

  function _wantDepthWriteback() { return (typeof window !== 'undefined' && window.__planetDepthToCanvas === true && !!_vdrsDepth); }
  function _writebackDstNearFar() {
    const _hostNF = (typeof window !== 'undefined') ? window.__hostNearFar : null;
    _wbDst[0] = (_hostNF && Number.isFinite(_hostNF.near)) ? _hostNF.near : _F.near;
    _wbDst[1] = (_hostNF && Number.isFinite(_hostNF.far)) ? _hostNF.far : _F.far;
    return _wbDst;
  }
  const _wbDst = [0, 0];
  function passPlanetDepthWriteback() {
    if (!_wantDepthWriteback()) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.ALWAYS);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.useProgram(dwProg);
    gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth); gl.uniform1i(dwUDepth, TU.upscale);
    gl.uniform1f(dwUBias, (typeof window !== 'undefined' && typeof window.__planetDepthBias === 'number') ? window.__planetDepthBias : 2e-6);
    gl.uniform2f(dwUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
    const dst = _writebackDstNearFar();
    gl.uniform1f(dwUSrcNear, _F.near); gl.uniform1f(dwUSrcFar, _F.far);
    gl.uniform1f(dwUDstNear, dst[0]); gl.uniform1f(dwUDstFar, dst[1]);
    gl.bindVertexArray(upVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true); gl.depthFunc(gl.LESS);
    gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
    return true;
  }
  function passUpscaleAndDepthWriteback() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.ALWAYS);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.useProgram(udwProg);
    gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsColor); gl.uniform1i(udwUTex, TU.upscale);
    gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth); gl.uniform1i(udwUDepth, TU.sceneDepth);
    gl.uniform1f(udwUBias, (typeof window !== 'undefined' && typeof window.__planetDepthBias === 'number') ? window.__planetDepthBias : 2e-6);
    gl.uniform2f(udwUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
    const dst = _writebackDstNearFar();
    gl.uniform1f(udwUSrcNear, _F.near); gl.uniform1f(udwUSrcFar, _F.far);
    gl.uniform1f(udwUDstNear, dst[0]); gl.uniform1f(udwUDstFar, dst[1]);
    gl.bindVertexArray(upVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    gl.depthFunc(gl.LESS);
    gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
    return true;
  }

  function setFrameUniforms() {
    const cam = _F.cam, sunDir = _F.sunDir, time = _F.time, chu = _activeChu;
    gl.uniform3f(U('camWorld'), cam.eye[0], cam.eye[1], cam.eye[2]);
    _chuSet1f(U, chu, 'terrainR', R);
    _chuSetM4(U, chu, 'defViewProjNoEye', _F.viewProjNoEye);
    gl.uniform3f(U('defCamDir'), _F.camDirX, _F.camDirY, _F.camDirZ);
    gl.uniform1f(U('defCamAlt'), _F.camAlt);
    _chuSet1i(U, chu, 'hpfPool', TU.hpf);
    _chuSet1i(U, chu, 'hpfPool2', TU.hpf2);
    _chuSet1i(U, chu, 'hasHpf', _hpfTex ? 1 : 0);
    _chuSet1i(U, chu, 'uTransmittanceLUT', TU.transmittanceLUT);
    _chuSet1i(U, chu, 'uScatteringLUT', TU.scatteringLUT);
    _chuSet1f(U, chu, 'uUseScatteringLUT', (typeof window !== 'undefined' && window.__useScatteringLUT != null) ? +window.__useScatteringLUT : 0);
    setComposeHeightUniforms(U, chu);
    _chuSet1f(U, chu, 'uVertexAO',      _g('vertexAO', TD.vertexAO));
    _chuSet1f(U, chu, 'uAoAmt',         _g('aoAmt', TD.aoAmt));
    _chuSet1f(U, chu, 'uWireframe',     (typeof window!=='undefined' && window.__wireframe) ? 1.0 : 0.0);
    _chuSet1f(U, chu, 'uWetness',        _g('wetness', 0));
    _chuSet1f(U, chu, 'uFsCheap',        (typeof window!=='undefined' && window.__fsCheap) ? 1.0 : 0.0);
    _chuSet1f(U, chu, 'uVariationAmt',   _g('variationAmt', TD.variationAmt));
    _chuSet1f(U, chu, 'uHazeMul',        _g('hazeMul', TD.hazeMul));
    const hasSurf = !!_surfAlb && !!_surfNrm;
    _chuSet1i(U, chu, 'uSurfAlb', TU.surfAlb);
    _chuSet1i(U, chu, 'uSurfNrm', TU.surfNrm);
    _chuSet1f(U, chu, 'uHasSurfTex', hasSurf ? 1.0 : 0.0);
    const _texTileM = _g('texTile', TD.texTile) * (R / DESIGN_RADIUS_M);
    _chuSet1f(U, chu, 'uTexTileM',   _texTileM);
    const _wrapM = _texTileM * 8.0;
    gl.uniform3f(U('uTexCamFrac'),
      cam.eye[0] - Math.floor(cam.eye[0] / _wrapM) * _wrapM,
      cam.eye[1] - Math.floor(cam.eye[1] / _wrapM) * _wrapM,
      cam.eye[2] - Math.floor(cam.eye[2] / _wrapM) * _wrapM);
    _chuSet1f(U, chu, 'uTexNrmK',    _g('texNrmK', TD.texNrmK));
    _chuSet1f(U, chu, 'uBiomeTint',  _g('biomeTint', TD.biomeTint));
    _chuSet1f(U, chu, 'uTexBright',  _g('texBright', TD.texBright));
    _chuSet1f(U, chu, 'uTexSat',     _g('texSat', TD.texSat));
    _chuSet1f(U, chu, 'uXSoft',      _g('xSoft', TD.xSoft));
    _chuSet1f(U, chu, 'uXFinger',    _g('xFinger', TD.xFinger));
    _chuSet1f(U, chu, 'uOrdPush',    _g('ordPush', TD.ordPush));
    _chuSet1f(U, chu, 'uBiomeWarp',  _g('biomeWarp', TD.biomeWarp));
    _chuSet1f(U, chu, 'uNrmLow',     _g('nrmLow', TD.nrmLow));
    _chuSet1f(U, chu, 'uXFade0',     _g('xFade0', TD.xFade0));
    _chuSet1f(U, chu, 'uXFade1',     _g('xFade1', TD.xFade1));
    _chuSet1f(U, chu, 'uTriSharp',   _g('triSharp', TD.triSharp));
    _chuSet1f(U, chu, 'uNrmFade0',   _g('nrmFade0', TD.nrmFade0));
    _chuSet1f(U, chu, 'uNrmFade1',   _g('nrmFade1', TD.nrmFade1));
    _chuSet1f(U, chu, 'uOctFar0',    _g('octFar0',  TD.octFar0));
    _chuSet1f(U, chu, 'uOctFar1',    _g('octFar1',  TD.octFar1));
    _chuSet1f(U, chu, 'uBandWarp',   _g('bandWarp', TD.bandWarp));
    _chuSet1f(U, chu, 'uBeachWidth', _g('beachWidth', TD.beachWidth));
    _chuSet1f(U, chu, 'uTexFar0',    _g('texFar0', TD.texFar0));
    _chuSet1f(U, chu, 'uTexFar1',    _g('texFar1', TD.texFar1));
    _chuSet1f(U, chu, 'uTexMix',     _g('texMix', TD.texMix));
    _chuSet1f(U, chu, 'uTexWarp',    _g('texWarp', TD.texWarp));
    _chuSet1f(U, chu, 'uTexPhoto',   _g('texPhoto', TD.texPhoto));
    _chuSet1f(U, chu, 'uTexPhotoNear', _g('texPhotoNear', TD.texPhotoNear));
    _chuSet4f(U, chu, 'uSurfMeanL', _surfMeanL[0], _surfMeanL[1], _surfMeanL[2], _surfMeanL[3]);
    _chuSet1f(U, chu, 'uFlatNormal',      _g('flatNormal', TD.flatNormal));
    _chuSet1f(U, chu, 'uReliefShade',    _g('reliefShade', TD.reliefShade));
    _chuSet1f(U, chu, 'uSkyFill',        _g('skyFill', TD.skyFill));
    _chuSet1f(U, chu, 'uTerminatorGlow', _g('terminatorGlow', TD.terminatorGlow));
    _chuSet1f(U, chu, 'uNightLights',    _g('nightLights', TD.nightLights));
    _chuSet1f(U, chu, 'uNightFloor',     _g('nightFloor', TD.nightFloor));
    _chuSet1f(U, chu, 'uTermWidth',      _g('termWidth', TD.termWidth));
    _chuSet1f(U, chu, 'uExposure',       _g('exposure', TD.exposure));
    _chuSet1f(U, chu, 'uLookSat',        _g('lookSat', TD.lookSat));
    _chuSet1f(U, chu, 'uLookContrast',   _g('lookContrast', TD.lookContrast));
    _o3('uOceanDeep',TD.uOceanDeep); _o3('uOceanShallow',TD.uOceanShallow); _o3('uOceanK',TD.uOceanK);
    _c3('bcDeepSea',TD.bcDeepSea); _c3('bcSea',TD.bcSea); _c3('bcShore',TD.bcShore);
    _c3('bcLowland',TD.bcLowland); _c3('bcGrass',TD.bcGrass);
    _c3('bcRock', (typeof window!=='undefined' && window.__surfRockMean) || TD.bcRock);
    _c3('bcSnow',TD.bcSnow);
    { const e=_C('bandEdgesLo',TD.bandEdgesLo); _chuSet2f(U, chu, 'bandEdgesLo', e[0],e[1]);
      const eh=_C('bandEdgesHi',TD.bandEdgesHi); _chuSet2f(U, chu, 'bandEdgesHi', eh[0],eh[1]);
      const sn=_C('snowEdges',TD.snowEdges); _chuSet2f(U, chu, 'snowEdges', sn[0],sn[1]);
      _chuSet1f(U, chu, 'seaDepthM', _C('seaDepthM',TD.seaDepthM));
      const sr=_C('slopeRock',TD.slopeRock); _chuSet2f(U, chu, 'slopeRock', sr[0],sr[1]); }
    _chuSet3f(U, chu, 'sunDir', sunDir[0], sunDir[1], sunDir[2]);
    _chuSet1i(U, chu, 'displayMode', cam.displayMode||0);
    const _si = cam.shadowInfo;
    _chuSet1i(U, chu, 'uShadowMap', TU.shadow);
    if (_si && _si.hasShadow && _si.texture) {
      _chuSetM4(U, chu, 'uShadowMatrix', _si.matrix);
      _chuSet1f(U, chu, 'uHasShadow', 1.0);
      _chuSet1f(U, chu, 'uShadowTexelSize', 1.0 / (_si.mapSize || 1024));
      _chuSet1f(U, chu, 'uShadowBias', _si.bias || 0.0);
    } else {
      _chuSet1f(U, chu, 'uHasShadow', 0.0);
    }
    const oc = (typeof window !== 'undefined' && window.__cam) || _ocEmpty;
    gl.uniform1f(U('oceanTime'), time || 0.0);
    _chuSet1f(U, chu, 'oceanAmp', (oc.oceanAmplitude != null) ? oc.oceanAmplitude : 1.0);
    _chuSet1f(U, chu, 'oceanChoppy', (oc.oceanChoppiness != null) ? oc.oceanChoppiness : 0.5);
    _chuSet1f(U, chu, 'oceanFoam', (oc.oceanFoam != null) ? oc.oceanFoam : 0.5);
    _chuSet1f(U, chu, 'uBeachTopM', _g('beachTop', TD.beachTop));
    _chuSetM4(U, chu, 'defViewProjRel', _F.viewProjRel);
    _chuSet1f(U, chu, 'defRadius', R);
    _chuSet1f(U, chu, 'uMorphSplitDist', (cam && cam.morphSplitDist > 0) ? cam.morphSplitDist : 0.0);
    _chuSet1f(U, chu, 'uMorphDistFactor', (cam && cam.morphDistFactor > 0) ? cam.morphDistFactor : 1.0);
    _chuSet1f(U, chu, 'uMorphMaxLevel', (cam && cam.morphMaxLevel > 0) ? cam.morphMaxLevel : 0.0);
    _chuSet1i(U, chu, 'uHeightPool', TU.heightPool);
    _chuSet1i(U, chu, 'uSceneTex', TU.sceneTex);
    _chuSet1f(U, chu, 'uUnderwater', (_F.camDist < R - 2.0) ? 1.0 : 0.0);
  }
  const _ocEmpty = {};

  function bindFrameTextures(cam, thc) {
    const hasHpf = !!_hpfTex;
    gl.activeTexture(gl.TEXTURE0 + TU.hpf);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hasHpf ? _hpfTex : ensureDummyHeightPoolTex());
    gl.activeTexture(gl.TEXTURE0 + TU.hpf2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, (hasHpf && _hpfTex2) ? _hpfTex2 : ensureDummyHeightPoolTex());
    gl.activeTexture(gl.TEXTURE0 + TU.transmittanceLUT);
    gl.bindTexture(gl.TEXTURE_2D, ensureTransmittanceLUT());
    gl.activeTexture(gl.TEXTURE0 + TU.scatteringLUT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ensureScatteringLUT());
    const hasSurf = !!_surfAlb && !!_surfNrm;
    const _surfTex = hasSurf ? _surfAlb : ensureDummySurfTex();
    const _surfTexN = hasSurf ? _surfNrm : _surfTex;
    gl.activeTexture(gl.TEXTURE0 + TU.surfAlb); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _surfTex);
    gl.activeTexture(gl.TEXTURE0 + TU.surfNrm); gl.bindTexture(gl.TEXTURE_2D_ARRAY, _surfTexN);
    const _si = cam.shadowInfo;
    gl.activeTexture(gl.TEXTURE0 + TU.shadow);
    if (_si && _si.hasShadow && _si.texture) { gl.bindTexture(gl.TEXTURE_2D, _si.texture); }
    else {
      gl.bindTexture(gl.TEXTURE_2D, ensureDummyShadowTex());
      if (typeof window !== 'undefined' && window.__wantShadowProbe) {
        window.__shadowProbeCompareMode = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE);
        window.__shadowProbeBoundTex = !!gl.getParameter(gl.TEXTURE_BINDING_2D);
        window.__shadowProbeIsDummy = gl.getParameter(gl.TEXTURE_BINDING_2D) === _dummyShadowTex;
      }
    }
    gl.activeTexture(gl.TEXTURE0 + TU.heightPool); gl.bindTexture(gl.TEXTURE_2D_ARRAY, thc ? heightPool : ensureDummyHeightPoolTex());
    gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, ensureDummySceneTex());
  }

  const _sortCounts = new Int32Array(DIST_SORT_BUCKETS + 1);
  let _scrOrdTmp = new Int32Array(0);
  function _sortLeavesFrontToBack(n, quads, eye) {
    if (_scrOrdTmp.length < n) _scrOrdTmp = new Int32Array(n);
    const dist = _scrD2, ord = _scrOrd;
    const WK = Math.PI / 4.0;
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const q = quads[i].quad; const ff = _faceFrames[quads[i].face | 0];
      const cx = q.ox + q.l * 0.5, cy = q.oy + q.l * 0.5;
      const wx = R * Math.tan((cx / R) * WK), wy = R * Math.tan((cy / R) * WK);
      const il = 1.0 / (Math.sqrt(wx*wx + wy*wy + R*R) || 1);
      const dx = (wx*il)*ff[0] + (wy*il)*ff[3] + (R*il)*ff[6];
      const dy = (wx*il)*ff[1] + (wy*il)*ff[4] + (R*il)*ff[7];
      const dz = (wx*il)*ff[2] + (wy*il)*ff[5] + (R*il)*ff[8];
      const ex = dx*R - eye[0], ey = dy*R - eye[1], ez = dz*R - eye[2];
      const d = Math.sqrt(ex*ex + ey*ey + ez*ez);
      dist[i] = d; if (d < dmin) dmin = d; if (d > dmax) dmax = d;
    }
    const counts = _sortCounts; counts.fill(0);
    const scale = (dmax > dmin) ? DIST_SORT_MAX_BUCKET / (dmax - dmin) : 0.0;
    const tmp = _scrOrdTmp;
    for (let i = 0; i < n; i++) { let b = ((dist[i] - dmin) * scale) | 0; if (b > DIST_SORT_MAX_BUCKET) b = DIST_SORT_MAX_BUCKET; tmp[i] = b; counts[b + 1]++; }
    for (let b = 0; b < DIST_SORT_BUCKETS; b++) counts[b + 1] += counts[b];
    for (let i = 0; i < n; i++) ord[counts[tmp[i]]++] = i;
    return ord;
  }

  function render(quads, cam, sunDir, time) {
    if (bakeOnly) throw new Error('mapspinner: render() is unavailable on a bakeOnly instance (patch-baker)');
    const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const camDist = Math.hypot(cam.eye[0], cam.eye[1], cam.eye[2]);
    const alt = Math.max(0.0, camDist - R);
    const altAboveTerrain = Math.max(0.001, alt - R * (cam.surfElev || 0));
    const RHORIZON = R - HORIZON_SPHERE_DEPTH_BELOW_SEA;
    const horizon = (camDist > RHORIZON) ? Math.sqrt(camDist*camDist - RHORIZON*RHORIZON) : SUBMERGED_FAR_REACH;
    const near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5);
    const _fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0));
    const farGround = Math.max(horizon, alt * 8.0);
    const far = farGround * (1.0 - _fBlend) + camDist * _fBlend;
    _octClampAlt = alt * (DESIGN_RADIUS_M / R);
    const eye = cam.eye;
    const _cmIn = cam.cullMatrix;
    const _cm = (_cmIn && _cmIn.near === near && _cmIn.far === far && _cmIn.eye === eye) ? _cmIn : cullMatrix(cam, { aspect, near, far });
    const viewProjRel = _cm.viewProjRel;
    const viewProjNoEye = _cm.viewProjNoEye;
    const _camDist = camDist || 1;
    const camAlt = _camDist - R;
    _F.cam = cam; _F.sunDir = sunDir; _F.time = time; _F.eye = eye;
    _F.aspect = aspect; _F.near = near; _F.far = far; _F.alt = alt; _F.camDist = camDist; _F.camAlt = camAlt;
    _F.camDirX = eye[0]/_camDist; _F.camDirY = eye[1]/_camDist; _F.camDirZ = eye[2]/_camDist;
    _F.cm = _cm; _F.viewProjRel = viewProjRel; _F.viewProjNoEye = viewProjNoEye;
    _F.bm = (typeof window!=='undefined' && window.__gen && window.__gen.state && window.__gen.state.biome) || null;
    if (typeof window !== 'undefined') {
      const pnf = _planetNearFarScratch; pnf.near = near; pnf.far = far; pnf.fovy = cam.fovy || 0.785; pnf.aspect = aspect;
      window.__planetNearFar = pnf;
      window.__lastVP = viewProjRel;
      let fin = true; for (let i = 0; i < 16; i++) if (!Number.isFinite(viewProjRel[i])) { fin = false; break; }
      window.__lastVPFinite = fin;
      window.__deviceLost = gl.isContextLost();
    }

    const _vW = gl.drawingBufferWidth, _vH = gl.drawingBufferHeight;
    let _vrs = 0;
    const _hrwActive = (typeof window==='undefined' || window.__halfResWater!==false) && (camDist >= R - 2.0);
    const _hostNF = (typeof window !== 'undefined') ? window.__hostNearFar : null;
    const _hostNearFarMismatch = !!(_hostNF && Number.isFinite(_hostNF.near) && Number.isFinite(_hostNF.far)
      && (Math.abs(_hostNF.near - near) > 1e-6 || Math.abs(_hostNF.far - far) > 1e-3));
    const _vdrsOn = (typeof window!=='undefined' && window.__vdrs === true) || _hrwActive || _hostNearFarMismatch;
    const _thc = thcActive();
    if (_vdrsOn && !_thc) {
      _vrs = (typeof window!=='undefined' && window.__vdrs === true) ? Math.min(1.0, Math.max(0.3, +window.__vdrsScale || 1.0)) : 1.0;
      ensureVdrsTargets(_vW, _vH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
      gl.viewport(0, 0, Math.max(1, Math.round(_vW*_vrs)), Math.max(1, Math.round(_vH*_vrs)));
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0,0,_vW,_vH);
    }
    _vdrsRsThisFrame = _vrs; _F.vW = _vW; _F.vH = _vH; _F.vrs = _vrs;
    gl.clearColor(0.0,0.0,0.0,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    const cmode = (typeof window !== 'undefined' && window.__cullMode) || 'front';
    if (cmode === 'none') { gl.disable(gl.CULL_FACE); }
    else { gl.enable(gl.CULL_FACE); gl.cullFace((cmode === 'back') ? gl.BACK : gl.FRONT); gl.frontFace(gl.CCW); }
    const _dm = cam.displayMode||0;
    if (DEBUG_MODES.has(_dm)) {
      ensureDebug();
      if (debugProg) setActiveProgram(debugProg, _dbgUloc, _chuD); else setActiveProgram(prog, _uloc, _chuR);
    } else { setActiveProgram(prog, _uloc, _chuR); }
    const _terrainProg = _activeProg, _terrainUloc = _activeUloc, _terrainChu = _activeChu;
    const n = quads.length;
    const FLOATS = 6;
    const STRIDE = FLOATS * 4;
    let _layers = null;
    if (n > 0 && _thc) {
      _tcFrame++; _tcBakesThisFrame = 0;
      _layers = new Float32Array(n);
      for (let i = 0; i < n; i++) { const q = quads[i].quad; _layers[i] = ensureTileLayer(quads[i].face, q.ox, q.oy, q.l, q.level); }
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.enable(gl.DEPTH_TEST);
      if (typeof window !== 'undefined') window.__thcBakes = _tcBakesThisFrame;
    }
    bindFrameTextures(cam, _thc);
    gl.useProgram(_terrainProg);
    setFrameUniforms();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);

    if (n > 0) {
      const _dirty = (quads !== _instQuadsRef) || (_thc !== _lastThc);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      if (_dirty) {
        _ensureScratch(n, FLOATS);
        const ordN = _sortLeavesFrontToBack(n, quads, cam.eye);
        const inst = (_scrInst.length === n * FLOATS) ? _scrInst : _scrInst.subarray(0, n * FLOATS);
        for (let k = 0; k < n; k++) {
          const i = ordN[k];
          const q = quads[i].quad;
          inst[k*FLOATS+0] = q.ox; inst[k*FLOATS+1] = q.oy; inst[k*FLOATS+2] = q.l; inst[k*FLOATS+3] = q.level;
          inst[k*FLOATS+4] = quads[i].face;
          inst[k*FLOATS+5] = _layers ? _layers[i] : 0.0;
        }
        gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
      }
      _lastThc = _thc;
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);          gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4);      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4);      gl.vertexAttribDivisor(3, 1);
      _chuSet1f(U, _terrainChu, 'uThc', _thc ? 1.0 : 0.0);
      if (_thc) {
        _chuSet1f(U, _terrainChu, 'uPoolRes', THC_BAKE_RES); _chuSet1f(U, _terrainChu, 'uPoolLinear', _halfFloatLinearOK ? 1.0 : 0.0);
      }
      gl.uniform1f(U('uIsWater'), 0.0);
      gl.uniform1f(U('uOccludeDepth'), 0.0);
      const _uw = camDist < R - 2.0;
      gl.drawElementsInstanced(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0, n);
      if (typeof window === 'undefined' || window.__waterSurface !== false) {
        setActiveProgram(waterProg, _wUloc, _chuW);
        gl.useProgram(waterProg);
        setFrameUniforms();
        _chuSet1f(U, _chuW, 'uThc', _thc ? 1.0 : 0.0);
        if (_thc) { _chuSet1f(U, _chuW, 'uPoolRes', THC_BAKE_RES); _chuSet1f(U, _chuW, 'uPoolLinear', _halfFloatLinearOK ? 1.0 : 0.0); }
        const WCAP = 11;
        gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
        if (_dirty || quads !== _instWaterRef) {
          _ensureWaterScratch(n, FLOATS);
          const wl = _scrWl;
          const seen = _waterSeen; seen.clear(); let wc = 0;
          const WKEY_BIG = 4096, WKEY_OFF = WKEY_BIG >> 1;
          for (let i = 0; i < n; i++) {
            const q = quads[i].quad; let ox = q.ox, oy = q.oy, l = q.l, lv = q.level;
            if (lv > WCAP) { const A = l * (1 << (lv - WCAP)); ox = Math.floor(ox / A) * A; oy = Math.floor(oy / A) * A; l = A; lv = WCAP; }
            const face = quads[i].face;
            const ix = Math.round(ox / l) + WKEY_OFF, iy = Math.round(oy / l) + WKEY_OFF;
            const key = ((face * WKEY_BIG + iy) * WKEY_BIG + ix) * (WCAP + 1) + lv;
            if (seen.has(key)) continue; seen.add(key);
            wl[wc*FLOATS+0]=ox; wl[wc*FLOATS+1]=oy; wl[wc*FLOATS+2]=l; wl[wc*FLOATS+3]=lv;
            wl[wc*FLOATS+4]=face; wl[wc*FLOATS+5]=0;
            wc++;
          }
          _instWaterN = wc;
          const wlView = (wl.length === wc * FLOATS) ? wl : wl.subarray(0, wc * FLOATS);
          gl.bufferData(gl.ARRAY_BUFFER, wlView, gl.DYNAMIC_DRAW);
          _instWaterRef = quads;
        }
        const wn = _instWaterN;
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
        const _sceneFbo = (_vdrsRsThisFrame > 0) ? _vdrsFbo : null;
        const _hrw = (typeof window==='undefined' || window.__halfResWater!==false) && !_uw && _sceneFbo === _vdrsFbo;
        let _waterHidden = false, _stampedThisFrame = false;
        const WATER_PROBE_GRAZING_UNRELIABLE_ABOVE_ALT_M = 2000.0;
        const _waterProbeReliable = alt >= WATER_PROBE_MIN_RELIABLE_ALT_M && alt < WATER_PROBE_GRAZING_UNRELIABLE_ABOVE_ALT_M;
        if (_hrw && _waterProbeReliable && typeof window !== 'undefined' && window.__planetDepthToCanvas === true
            && window.__waterDepthShareOff !== true && window.__waterVisGate !== false) {
          if (!_waterVisQ) _waterVisQ = gl.createQuery();
          if (_waterVisQPending && gl.getQueryParameter(_waterVisQ, gl.QUERY_RESULT_AVAILABLE)) {
            _waterVisZeroRuns = gl.getQueryParameter(_waterVisQ, gl.QUERY_RESULT) ? 0 : _waterVisZeroRuns + 1;
            _waterVisQPending = false;
          }
          _waterHidden = _waterVisZeroRuns >= WATER_HIDDEN_AFTER_EMPTY_QUERIES;
          window.__waterVisDebug = _waterVisDebugScratch; _waterVisDebugScratch.zeroRuns = _waterVisZeroRuns; _waterVisDebugScratch.pending = _waterVisQPending; _waterVisDebugScratch.hidden = _waterHidden;
          gl.colorMask(false, false, false, false);
          gl.disable(gl.BLEND);
          gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(false);
          gl.disable(gl.CULL_FACE);
          gl.uniform1f(U('uIsWater'), 1.0);
          gl.uniform1f(U('uOccludeDepth'), 0.0);
          gl.uniform1f(U('uDepthOnly'), 1.0);
          gl.uniform1f(U('uWaterVisProbe'), 1.0);
          gl.bindBuffer(gl.ARRAY_BUFFER, wvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wibo);
          gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
          gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
          gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
          gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
          const _issueQ = !_waterVisQPending;
          if (_issueQ) gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, _waterVisQ);
          gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
          if (_issueQ) { gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE); _waterVisQPending = true; }
          if (window.__glCheck) window.__waterProbeGLErr = gl.getError();
          gl.depthFunc(gl.LESS); gl.depthMask(true);
          gl.enable(gl.CULL_FACE);
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
          gl.uniform1f(U('uIsWater'), 0.0);
          gl.uniform1f(U('uDepthOnly'), 0.0);
          gl.uniform1f(U('uWaterVisProbe'), 0.0);
          gl.colorMask(true, true, true, true);
          if (_waterHidden) window.__waterVisSkips = (window.__waterVisSkips|0) + 1;
        }
        if (!_waterHidden) {
        ensureSceneCopy(_vW, _vH);
        gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, _sceneCopyTex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, _vW, _vH);
        _chuSet1i(U, _chuW, 'uSceneTex', TU.sceneTex);
        gl.uniform2f(U('uResolution'), _vW, _vH);
        let _hrwVW=0, _hrwVH=0;
        if (_hrw) {
          _hrwVW = Math.max(1, _vW>>1); _hrwVH = Math.max(1, _vH>>1);
          ensureHrwTargets(_hrwVW, _hrwVH);
          gl.bindFramebuffer(gl.FRAMEBUFFER, _hrwFbo);
          gl.viewport(0,0,_hrwVW,_hrwVH);
          gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
          gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth); gl.uniform1i(U('uSceneDepth'), TU.sceneDepth);
          gl.uniform1f(U('uOccludeDepth'), 1.0);
          gl.uniform2f(U('uResolution'), _hrwVW, _hrwVH);
        }
        if (_uw) {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        } else {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        }
        const _waterCullFront = !_uw && !(Math.abs(camAlt) < WATER_WINDING_FLIP_ALT_M);
        if (!_waterCullFront) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); gl.frontFace(gl.CCW); }
        gl.uniform1f(U('uIsWater'), 1.0);
        gl.bindBuffer(gl.ARRAY_BUFFER, wvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wibo);
        gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
        gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
        if (typeof window !== 'undefined' && window.__passProbe === true) {
          const _cc = gl.getParameter(gl.CULL_FACE), _cm2 = gl.getParameter(gl.CULL_FACE_MODE), _ff = gl.getParameter(gl.FRONT_FACE);
          (window.__passProbeLog = window.__passProbeLog || []).push('water-color draw: cullEnabled=' + _cc + ' cullFace=' + (_cm2 === gl.FRONT ? 'FRONT' : 'BACK') + ' frontFace=' + (_ff === gl.CCW ? 'CCW' : 'CW') + ' _hrw=' + _hrw + ' quads=' + wn + ' _uw=' + _uw + ' camAlt=' + camAlt.toFixed(2) + ' eyeY=' + eye[1].toFixed(2));
          if (_hrw && _hrwColor && _hrwW > 0) _passProbeSnap('water-color-hrw', _hrwColor, _hrwW, _hrwH);
          else if (!_hrw) _passProbeSnap('water-color-direct-canvas', null, 0, 0);
        }
        if (!_hrw && !_uw && typeof window !== 'undefined' && window.__planetDepthToCanvas === true && window.__waterDepthShareOff !== true) {
          gl.colorMask(false, false, false, false);
          gl.depthMask(true); gl.disable(gl.BLEND);
          gl.uniform1f(U('uDepthOnly'), 1.0);
          gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
          gl.uniform1f(U('uDepthOnly'), 0.0);
          gl.colorMask(true, true, true, true);
          window.__waterDepthShared = (window.__waterDepthShared|0) + 1;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.uniform1f(U('uIsWater'), 0.0);
        gl.enable(gl.CULL_FACE);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        if (_hrw) {
          gl.uniform1f(U('uOccludeDepth'), 0.0);
          gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFbo);
          gl.viewport(0,0, (_sceneFbo? Math.max(1,Math.round(_vW*_vrs)) : _vW), (_sceneFbo? Math.max(1,Math.round(_vH*_vrs)) : _vH));
          gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
          gl.useProgram(upProg);
          gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, _hrwColor); gl.uniform1i(cmpUTex, TU.sceneTex);
          gl.uniform2f(upUScale, 1.0, 1.0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.activeTexture(gl.TEXTURE0 + TU.sceneTex); gl.bindTexture(gl.TEXTURE_2D, null);
          gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
          gl.useProgram(waterProg);
          if (!_stampedThisFrame && typeof window !== 'undefined' && window.__planetDepthToCanvas === true && window.__waterDepthShareOff !== true && _vdrsDepth) {
            gl.activeTexture(gl.TEXTURE0 + TU.sceneDepth); gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
            gl.viewport(0, 0, Math.max(1, Math.round(_vW*_vrs)), Math.max(1, Math.round(_vH*_vrs)));
            gl.colorMask(false, false, false, false);
            gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
            gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); gl.frontFace(gl.CCW);
            gl.uniform1f(U('uIsWater'), 1.0);
            gl.uniform1f(U('uOccludeDepth'), 0.0);
            gl.uniform1f(U('uDepthOnly'), 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, wvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wibo);
            gl.bindBuffer(gl.ARRAY_BUFFER, instBufWater);
            gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);     gl.vertexAttribDivisor(1, 1);
            gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 4 * 4); gl.vertexAttribDivisor(2, 1);
            gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 5 * 4); gl.vertexAttribDivisor(3, 1);
            gl.drawElementsInstanced(gl.TRIANGLES, waterIndices.length, gl.UNSIGNED_INT, 0, wn);
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
            gl.uniform1f(U('uIsWater'), 0.0);
            gl.uniform1f(U('uDepthOnly'), 0.0);
            gl.colorMask(true, true, true, true);
            if (typeof window !== 'undefined') window.__waterDepthShared = (window.__waterDepthShared|0) + 1;
          }
        }
        }
        if (typeof window !== 'undefined' && window.__passProbe === true && _vdrsColor && _vdrsW > 0) _passProbeSnap('after-water-composite-vdrs', _vdrsColor, _vdrsW, _vdrsH);
        if (typeof window !== 'undefined') window.__lastWaterQuads = wn;
        setActiveProgram(_terrainProg, _terrainUloc, _terrainChu);
        gl.useProgram(_terrainProg);
      }
      _instQuadsRef = quads;
      if (typeof window !== 'undefined') window.__instUploads = (window.__instUploads | 0) + (_dirty ? 1 : 0);
    }
    if (typeof window !== 'undefined') window.__lastDrawCalls = (n > 0) ? 2 : 0;
    if (_vdrsRsThisFrame === 0) { drawSky(true); if (typeof window !== 'undefined' && window.__passProbe === true) _passProbeSnap('after-drawSky-straight-canvas', null, 0, 0); }

    if (_vdrsRsThisFrame > 0) {
      if (typeof window !== 'undefined' && window.__depthProbeOn && _vdrsDepth) {
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        if (!_dpFbo || _dpW !== W || _dpH !== H) {
          if (_dpTex) gl.deleteTexture(_dpTex);
          if (_dpFbo) gl.deleteFramebuffer(_dpFbo);
          _dpTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _dpTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          _dpFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, _dpFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _dpTex, 0);
          gl.bindTexture(gl.TEXTURE_2D, null);
          _dpW = W; _dpH = H;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, _dpFbo);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
        gl.useProgram(dpProg);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, _vdrsDepth);
        gl.uniform1i(dpUTex, TU.upscale);
        gl.uniform2f(dpUScale, _vdrsRsThisFrame, _vdrsRsThisFrame);
        gl.bindVertexArray(upVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0 + TU.upscale); gl.bindTexture(gl.TEXTURE_2D, null);
        try {
          const px = new Uint8Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          window.__depthProbe = { w: W, h: H, px };
        } catch (_) {}
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(_activeProg);
      }
      if (typeof window !== 'undefined' && window.__wantVdrsColorProbe) {
        try {
          const probeFbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _vdrsColor, 0);
          const px = new Uint8Array(4);
          gl.readPixels(Math.floor(_vW*_vrs/2), Math.floor(_vH*_vrs/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          window.__vdrsColorProbe = { px: Array.from(px) };
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(probeFbo);
        } catch (e) { window.__vdrsColorProbe = { error: String(e) }; }
      }
      const _fsr1 = (typeof window !== 'undefined' && window.__vdrsUpscaleFsr1 === true);
      let _wroteDepth, _skyInSceneFbo = false;
      if (!_fsr1 && _wantDepthWriteback()) {
        _wroteDepth = passUpscaleAndDepthWriteback();
        if (typeof window !== 'undefined' && window.__passProbe === true) { _passProbeSnap('after-upscale-canvas', null, 0, 0); (window.__passProbeLog = window.__passProbeLog || []).push('writeback ran=' + _wroteDepth + ' (merged)'); _passProbeSnap('after-writeback-canvas', null, 0, 0); }
      } else {
        _skyInSceneFbo = !_wantDepthWriteback();
        if (_skyInSceneFbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, _vdrsFbo);
          gl.viewport(0, 0, Math.max(1, Math.round(_vW*_vrs)), Math.max(1, Math.round(_vH*_vrs)));
          drawSky(true);
        }
        passUpscaleToCanvas();
        if (typeof window !== 'undefined' && window.__passProbe === true) _passProbeSnap('after-upscale-canvas', null, 0, 0);
        _wroteDepth = passPlanetDepthWriteback();
        if (typeof window !== 'undefined' && window.__passProbe === true) { (window.__passProbeLog = window.__passProbeLog || []).push('writeback ran=' + _wroteDepth); _passProbeSnap('after-writeback-canvas', null, 0, 0); }
      }
      if (!_skyInSceneFbo) drawSky(_wroteDepth);
      if (typeof window !== 'undefined' && window.__passProbe === true) {
        _passProbeSnap('after-drawSky-canvas', null, 0, 0);
        if ((window.__passProbeFrames || []).length >= 4 && window.__passProbeOneShot !== false) window.__passProbe = false;
      }
      gl.useProgram(_activeProg);
    }
    return 0;
  }
  const _planetNearFarScratch = { near: 0, far: 0, fovy: 0, aspect: 1 };
  const _waterVisDebugScratch = { zeroRuns: 0, pending: false, hidden: false };

  function checkGlError() { return gl.getError(); }

  function probe(quads, cam) {
    const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const near = (cam.near!=null)?cam.near:1.0, far=(cam.far!=null)?cam.far:R*8;
    const proj = M4.perspective(cam.fovy||0.785, aspect, near, far);
    const eye = cam.eye;
    const viewRel = M4.lookAt([0,0,0], [cam.center[0]-eye[0], cam.center[1]-eye[1], cam.center[2]-eye[2]], cam.up||[0,1,0]);
    const viewProjRel = M4.mul(M4.mul(proj, viewRel), M4.translate([-eye[0],-eye[1],-eye[2]]));
    const out = [];
    for (const q of quads) {
      const w3 = localToWorld3(q.face);
      const w4 = new Float32Array([ w3[0],w3[1],w3[2],0, w3[3],w3[4],w3[5],0, w3[6],w3[7],w3[8],0, 0,0,0,1 ]);
      const localToScreen = M4.mul(viewProjRel, w4);
      const {ox,oy,l} = q.quad;
      const cs = [[ox,oy],[ox+l,oy],[ox,oy+l],[ox+l,oy+l]];
      const v=[],L=[];
      for (let i=0;i<4;i++){ const px=cs[i][0],py=cs[i][1]; const len=Math.hypot(px,py,R); L.push(len); v.push([px/len,py/len,R/len]); }
      const dCorners = new Float32Array([ v[0][0]*R,v[0][1]*R,v[0][2]*R,1, v[1][0]*R,v[1][1]*R,v[1][2]*R,1, v[2][0]*R,v[2][1]*R,v[2][2]*R,1, v[3][0]*R,v[3][1]*R,v[3][2]*R,1 ]);
      const C = M4.mul(localToScreen, dCorners);
      const ndc = [];
      for (let i=0;i<4;i++){ const x=C[i*4],y=C[i*4+1],z=C[i*4+2],w=C[i*4+3];
        ndc.push({x:+(x/w).toFixed(3),y:+(y/w).toFixed(3),z:+(z/w).toFixed(3),w:+w.toFixed(1),
          off: (w<=0)||Math.abs(x/w)>1||Math.abs(y/w)>1||(z/w)<-1||(z/w)>1}); }
      out.push({face:q.face, level:q.quad.level, ox:+ox.toFixed(0), oy:+oy.toFixed(0), l:+l.toFixed(0), ndc});
    }
    return out;
  }
  function setHpf(tex, res, tex2) { _hpfTex = tex; _hpfTex2 = tex2 || null; invalidatePool(); }

  const _contextLostCbs = [];
  let _canvasEl = null;
  try { _canvasEl = (gl && typeof gl.canvas !== 'undefined') ? gl.canvas : null; } catch (_) {}
  if (_canvasEl && typeof _canvasEl.addEventListener === 'function') {
    _canvasEl.addEventListener('webglcontextlost', (e) => {
      for (const cb of _contextLostCbs) { try { cb(e); } catch (_) {} }
    });
  }
  function isContextLost() { try { return !!(gl && gl.isContextLost && gl.isContextLost()); } catch (_) { return false; } }
  function onContextLost(cb) {
    if (typeof cb !== 'function') return () => {};
    _contextLostCbs.push(cb);
    return () => { const i = _contextLostCbs.indexOf(cb); if (i >= 0) _contextLostCbs.splice(i, 1); };
  }

  return { get prog(){ return prog; }, render, checkGlError, probe, sampleGroundM, sampleGroundMSync, cullMatrix, recompile, setHpf, isContextLost, onContextLost, GRID, indexCount: indices.length, M4, setSculptOverride, clearSculptOverride, SCULPT_RES };
}
