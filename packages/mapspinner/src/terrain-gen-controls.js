import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';

const ORCH = () => window.__planetOrch || null;
const HPF = () => window.__hpf || null;

const DEFAULTS = {
  normal: {
    pvNormal: TD.pvNormal,
    fsNormal: TD.fsNormal,
  },
  lod: {
    splitFactor: TD.splitFactor,
  },
  geometry: {
    elevEdgeInset: TD.elevEdgeInset,
  },
  biome: {
    bcDeepSea: TD.bcDeepSea, bcSea: TD.bcSea, bcShore: TD.bcShore,
    bcLowland: TD.bcLowland, bcGrass: TD.bcGrass, bcRock: TD.bcRock,
    bcSnow: TD.bcSnow,
    bandEdgesLo: TD.bandEdgesLo, bandEdgesHi: TD.bandEdgesHi, snowEdges: TD.snowEdges,
    seaDepthM: TD.seaDepthM, slopeRock: TD.slopeRock,
  },
  look: {
    exposure: TD.exposure, skyFill: TD.skyFill, variationAmt: TD.variationAmt, vertexAO: TD.vertexAO, reliefShade: TD.reliefShade,
    nightFloor: TD.nightFloor, termWidth: TD.termWidth, terminatorGlow: TD.terminatorGlow, lookSat: TD.lookSat, lookContrast: TD.lookContrast,
    detailOverlay: TD.detailOverlay, hazeMul: TD.hazeMul,
    ocean: { deep: TD.uOceanDeep, shallow: TD.uOceanShallow, k: TD.uOceanK },
  },
  hpf: {
    enabled: 1,
    band: [
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
    const orch = ORCH(); if(orch && orch.clearCache) orch.clearCache();
    return { ok: true };
  },

  set(path, v){
    const parts = path.split('.'); let o = this.state;
    for(let i=0;i<parts.length-1;i++){ o = o[parts[i]]; if(o==null) return {err:'bad-path:'+path}; }
    o[parts[parts.length-1]] = v;
    return this.apply();
  },

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
