import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';

const GROUPS = [
  ['Canyon / carve', [
    ['canyonDepth',   'Canyon depth',          0,   80,   1,    40.0],
    ['carveWide',     'Carve climate width',   0,   1,    0.05, 0.0],
  ]],
  ['Cliffs / mesa', [
    ['cliffAmt',      'Cliff / mesa amount',   0,   10,   0.1,  5.0],
  ]],
  ['Terrain shape', [
    ['detailOverlay', 'Detail overlay relief', 0,   100,  0.5,  53.0],
    ['hiFreqCut',     'Hi-freq octave cut',    0,   1,    0.05, 1.0],
    ['landBias',      'Land bias (m)',        -500000, 500000, 5000, 0.0],
    ['mtnBandWide',   'Mountain belt width',   0,   1,    0.05, 1.0],
    ['climateRelief', 'Climate relief width',  0,   1,    0.05, 1.0],
    ['isleWide',      'Island zone width',     0,   1,    0.05, 0.55],
    ['splitFactor',   'LOD density (split)',   0.05, 1.0, 0.01, 0.30],
  ]],
  ['Beach / coast', [
    ['beachTop',      'Beach ceiling (m)',     0,   1000, 10,   15.0],
    ['beachWidth',    'Beach crossover width', 0,   50,   0.5,  1.0],
    ['beachShelf',    'Coastal shelf (m)',     0,   1200, 50,   0.0],
    ['bandWarp',      'Biome-edge warp (m)',   0,   5000, 50,   20.0],
  ]],
  ['Texture', [
    ['texMix',        'Splat blend',           0,   1,    0.05, 1.0],
    ['texNrmK',       'Detail-normal strength',0,   4,    0.1,  0.4],
    ['nrmLow',        'Low-octave normal',     0,   3,    0.1,  0.4],
    ['triSharp',      'Triplanar sharpness',   0,   10,   0.1,  3.0],
    ['texSat',        'Texture saturation',    0,   2,    0.05, 1.0],
    ['texBright',     'Texture brightness',    0.2, 1.5,  0.02, 1.0],
    ['biomeTint',     'Biome tint / texture',  0,   1,    0.02, 0.62],
    ['texWarp',       'Anti-repeat warp',      0,   0.6,  0.02, 1.0],
    ['texTile',       'Texture tile size (m)', 100, 10000,100,  2400.0],
    ['xSoft',         'Crossover fade width',  0,   0.5,  0.02, 0.26],
    ['xFinger',       'Crossover fingering',   0,   5,    0.1,  0.2],
    ['ordPush',       'Overlay push (cover)',  0,   1.5,  0.05, 0.0],
    ['texPhoto',      'Photo color (far)',     0,   1,    0.05, 0.0],
    ['texPhotoNear',  'Photo color (near)',    0,   1,    0.05, 0.0],
    ['xFade0',        'Crossover fade start m',0,   1000, 10,   100.0],
    ['xFade1',        'Crossover fade end m',  0,   2000, 10,   340.0],
    ['texFar0',       'Splat fade start m',    0,   5000, 50,   0.0],
    ['texFar1',       'Splat fade end m',      0,   20000,50,   10000.0],
    ['nrmFade0',      'Normal fade start m',   0,   500000,5000,100.0],
    ['nrmFade1',      'Normal fade end m',     0,   5000000,50000,1000.0],
    ['octFar0',       'Coarse oct start m',    0,   500,  1,    1.5],
    ['octFar1',       'Coarse oct end m',      0,   2000, 5,    15.0],
  ]],
  ['Lighting / look', [
    ['exposure',      'Exposure',              0.2, 4,    0.05, 0.85],
    ['reliefShade',   'Relief shading',        0,   6,    0.1,  6.0],
    ['biomeWarp',     'Biome distribution warp',0,  3,    0.1,  1.1],
    ['variationAmt',  'Color variation',       0,   1,    0.01, 0.05],
    ['hazeMul',       'Aerial haze',           0,   2,    0.05, 0.4],
    ['skyFill',       'Sky fill',              0,   1,    0.05, 0.3],
    ['vertexAO',      'Vertex AO',             0,   2,    0.05, 0.0],
    ['aoAmt',         'Slope AO',              0,   3,    0.1,  0.0],
    ['lookSat',       'Final saturation',      0,   2,    0.05, 1.0],
    ['lookContrast',  'Final contrast',        0.5, 2,    0.02, 1.0],
    ['terminatorGlow','Terminator glow',       0,   1,    0.05, 0.6],
    ['nightFloor',    'Night floor',           0,   0.5,  0.02, 0.18],
    ['nightLights',   'Night fill',            0,   3,    0.1,  0.8],
    ['termWidth',     'Terminator width',      0.05,1,    0.05, 0.45],
    ['flatNormal',    'Flat normal (diag)',    0,   1,    1,    0.0],
  ]],
  ['Performance', [
    ['renderScale',   'Render scale (fps<->sharp)', 0.4, 1.5, 0.05, 1.0],
  ]],
];

function levDefault(key, rowDef){
  const v = TD[key];
  return (typeof v === 'number') ? v : rowDef;
}

function build(){
  if (document.getElementById('tweakPanel')) return;
  const btn = document.createElement('button');
  btn.id = 'tweakToggle'; btn.textContent = 'Tweaks';
  btn.style.cssText = 'position:fixed;left:92px;top:8px;z-index:31;font:11px monospace;padding:3px 7px';

  const panel = document.createElement('div');
  panel.id = 'tweakPanel';
  panel.style.cssText = 'position:fixed;left:8px;top:34px;z-index:31;display:none;max-height:90vh;overflow:auto;' +
    'background:rgba(12,16,20,0.94);color:#cfe;font:10px/1.4 monospace;padding:6px 8px;border:1px solid #2a3a44;width:330px';

  btn.onclick = () => {
    const show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    const gp = document.getElementById('genPanel'); if (gp && show) gp.style.display = 'none';
  };

  for (const [groupName, levers] of GROUPS) {
    const det = document.createElement('details');
    det.open = groupName === 'Canyon / carve' || groupName === 'Cliffs / mesa';
    const sum = document.createElement('summary');
    sum.textContent = groupName;
    sum.style.cssText = 'cursor:pointer;color:#9fd;font-weight:bold;margin:5px 0 2px';
    det.appendChild(sum);

    for (const [key, label, min, max, step, def] of levers) {
      const g = '__' + key;
      const dflt = levDefault(key, def);
      const cur = (window[g] != null) ? +window[g] : dflt;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;margin:1px 0';

      const lab = document.createElement('span');
      lab.textContent = label; lab.title = 'window.__' + key;
      lab.style.cssText = 'flex:0 0 120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis';

      const rng = document.createElement('input');
      rng.type = 'range'; rng.min = min; rng.max = max; rng.step = step; rng.value = cur; rng.style.flex = '1';

      const num = document.createElement('input');
      num.type = 'number'; num.min = min; num.max = max; num.step = step; num.value = cur;
      num.style.cssText = 'flex:0 0 60px;background:#0a0e12;color:#cfe;border:1px solid #2a3a44;font:10px monospace';

      const apply = (v) => { v = +v; if (!isFinite(v)) return; window[g] = v; rng.value = v; num.value = v;
        if (key === 'renderScale' && window.__setRenderScale) { window.__setRenderScale(v); return; }
        const o = window.__planetOrch; if (o && o.clearCache) o.clearCache(); };
      rng.oninput = () => apply(rng.value);
      num.oninput = () => apply(num.value);

      const rst = document.createElement('button');
      rst.textContent = 'r'; rst.title = 'reset to ' + dflt;
      rst.style.cssText = 'flex:0 0 16px;font:10px monospace;padding:0;cursor:pointer';
      rst.onclick = () => apply(dflt);

      row.append(lab, rng, num, rst);
      det.appendChild(row);
    }
    panel.appendChild(det);
  }

  document.body.append(btn, panel);
  window.__tweakPanel = { rebuild: build };
}

function boot(){ build(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
