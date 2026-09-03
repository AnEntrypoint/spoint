// terrain-gen-controls.js -- the ONE live control surface for terrain generation params.
// Imported by planet.html; installs window.__gen. No rebuild needed: shader params are window.*
// globals the render reads per-frame; HPF band scales go through the anchor field; biome colors
// are read live by gl-render.
//
// After the cascade/producer deletion (GPU one-fractal), the old elevation noiseAmp cascade +
// material ortho-noise tables are GONE: they fed setters that no longer exist. Only the params
// below still drive anything, so the panel shows only live knobs.
//
// __gen.defaults  - canonical default for every field (exact reset).
// __gen.state     - current values (mutated by sliders / set()).
// __gen.set(path,v)- set one field by dot-path, re-apply.
// __gen.apply()   - push the whole state to shader globals + HPF band scales.
// __gen.get()     - read back the live shader globals.
// __gen.reset()   - restore defaults and apply.
// __gen.serialize()/load(json) - persist/restore.

import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';

const ORCH = () => window.__planetOrch || null;
const HPF = () => window.__hpf || null;

// ---- canonical defaults: DERIVED from the SDK single source of truth (src/terrain-defaults.js).
// gen-controls is a LIVE OVERLAY; these values mirror TD so the panel's state/reset == the SDK
// default == the look gl-render renders with no override. NOT force-applied at boot (see boot note below).
const DEFAULTS = {
  normal: {
    pvNormal: TD.pvNormal,   // window.__pvNormal (per-vertex seamless normal, default on)
    fsNormal: TD.fsNormal,   // window.__fsNormal (cross-dFdx FS normal, diagnostic, default off)
  },
  lod: {
    splitFactor: TD.splitFactor,   // window.__splitFactor (blessed flat mesh density)
  },
  geometry: {
    elevEdgeInset: TD.elevEdgeInset,   // window.__elevEdgeInset (mesh-edge elevation sample inset; gl-render)
  },
  // biome ramp colors + band edges (gl-render reads window.__gen.state.biome live -- so these MUST
  // equal TD or the demo diverges from a bare SDK consumer). All sourced from TD.
  biome: {
    bcDeepSea: TD.bcDeepSea, bcSea: TD.bcSea, bcShore: TD.bcShore,
    bcLowland: TD.bcLowland, bcGrass: TD.bcGrass, bcRock: TD.bcRock,
    bcSnow: TD.bcSnow,
    bandEdgesLo: TD.bandEdgesLo, bandEdgesHi: TD.bandEdgesHi, snowEdges: TD.snowEdges,
    seaDepthM: TD.seaDepthM, slopeRock: TD.slopeRock,
  },
  // REAL-WORLD LOOK levers (applyShaderGlobals sets window globals when the user tweaks; gl-render
  // reads them via _g(), else the TD fallback). All sourced from TD.
  look: {
    exposure: TD.exposure, skyFill: TD.skyFill, variationAmt: TD.variationAmt, vertexAO: TD.vertexAO, reliefShade: TD.reliefShade,
    nightFloor: TD.nightFloor, termWidth: TD.termWidth, terminatorGlow: TD.terminatorGlow, lookSat: TD.lookSat, lookContrast: TD.lookContrast,
    detailOverlay: TD.detailOverlay, hazeMul: TD.hazeMul,
    ocean: { deep: TD.uOceanDeep, shallow: TD.uOceanShallow, k: TD.uOceanK },
  },
  // HPF band scales (multipliers on the anchor-field band base values; anchor-field.setBandScales).
  hpf: {
    enabled: 1,
    band: [
      // [continental, regional, local] -- scales multiply the band's baked param magnitude.
      { seaBiasScale: 1.0, elevAmpScale: 1.0, roughnessScale: 1.0 },
      { seaBiasScale: 1.0, elevAmpScale: 1.0, roughnessScale: 1.0 },
      { seaBiasScale: 1.0, elevAmpScale: 1.0, roughnessScale: 1.0 },
    ],
  },
};

function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

function applyShaderGlobals(state){
  window.__pvNormal      = state.normal.pvNormal;
  window.__fsNormal      = state.normal.fsNormal;
  window.__elevEdgeInset = state.geometry.elevEdgeInset;
  if(state.lod.splitFactor != null) window.__splitFactor = state.lod.splitFactor;
  const L = state.look; if(L){
    window.__exposure = L.exposure; window.__skyFill = L.skyFill;
    window.__variationAmt = L.variationAmt; window.__nightFloor = L.nightFloor; window.__termWidth = L.termWidth;
    if(L.detailOverlay != null) window.__detailOverlay = L.detailOverlay;
    if(L.hazeMul != null) window.__hazeMul = L.hazeMul;
    if(L.vertexAO != null) window.__vertexAO = L.vertexAO;
    if(L.reliefShade != null) window.__reliefShade = L.reliefShade;
    window.__terminatorGlow = L.terminatorGlow; window.__lookSat = L.lookSat; window.__lookContrast = L.lookContrast;
    // gl-render reads window['__'+uniformName] (gl-render.js o3 helper) -> the globals must carry
    // the 'u' prefix (__uOceanDeep, not __oceanDeep); the unprefixed names were dead levers.
    if(L.ocean){ window.__uOceanDeep = L.ocean.deep; window.__uOceanShallow = L.ocean.shallow; window.__uOceanK = L.ocean.k; }
  }
}
function applyHpf(state){
  const f = HPF(); if(!f) return false;
  if(f.setBandScales){ state.hpf.band.forEach((b,i)=> f.setBandScales(i, b)); }
  if(window.__hpfRebake) window.__hpfRebake();
  return true;
}

const __gen = {
  defaults: DEFAULTS,
  state: deepClone(DEFAULTS),

  apply(){
    applyShaderGlobals(this.state);
    applyHpf(this.state);
    const orch = ORCH(); if(orch && orch.clearCache) orch.clearCache();   // re-sync biome/HPF into the next frame
    return { ok: true };
  },

  // set one field by dot-path (e.g. 'biome.seaDepthM', 'hpf.band.1.elevAmpScale') and re-apply.
  set(path, v){
    const parts = path.split('.'); let o = this.state;
    for(let i=0;i<parts.length-1;i++){ o = o[parts[i]]; if(o==null) return {err:'bad-path:'+path}; }
    o[parts[parts.length-1]] = v;
    return this.apply();
  },

  // read the LIVE shader globals back (truth, not just this.state).
  get(){
    return { state: deepClone(this.state),
      liveShader: { pvNormal:window.__pvNormal, fsNormal:window.__fsNormal,
                    elevEdgeInset:window.__elevEdgeInset, splitFactor:window.__splitFactor } };
  },

  reset(){ this.state = deepClone(this.defaults); return this.apply(); },
  serialize(){ return JSON.stringify(this.state); },
  load(json){ try{ this.state = (typeof json==='string')?JSON.parse(json):json; return this.apply(); }catch(e){ return {err:String(e)}; } },
};

if (typeof window !== 'undefined') window.__gen = __gen;
export default __gen;
