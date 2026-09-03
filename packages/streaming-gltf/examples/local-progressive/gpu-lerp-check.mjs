#!/usr/bin/env node
// gpu-lerp-check.mjs — witnesses that the BatchedMesh far tier interpolates
// position ON THE GPU: after a setTarget, the CPU must NOT call setMatrixAt per
// frame for the in-flight entity (the vertex shader does the lerp). Also reads
// back the written lerp texel and confirms the GL program compiled (no errors).
//   node examples/local-progressive/gpu-lerp-check.mjs [count]
// Defaults the bundled Chromium's GPU backend to real ANGLE/D3D11 (fast, real
// shader compile) instead of the slow SwiftShader fallback -- see the caveat
// in measure-fps.mjs. ANGLE=swiftshader / ANGLE=none / CHANNEL=chrome override.
import { chromium } from '../../../../scripts/lib/cdp-browser.mjs';
const PORT = process.env.PORT || 5180;
const N = Number(process.argv[2] || 500);
const URL = `http://127.0.0.1:${PORT}/stress.html?cb=${Date.now()}`;
const angle = process.env.ANGLE || 'd3d11';
const launchOpts = { headless: true, args: angle === 'none' ? [] : [`--use-angle=${angle}`, '--use-gl=angle'] };
if (process.env.CHANNEL) launchOpts.channel = process.env.CHANNEL;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
try {
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__pool && window.__pool.getStats, { timeout: 30000 });
  await page.evaluate((n) => {
    const o=document.getElementById('orbit-cam'); if(o&&o.checked)o.click();
    const z=document.getElementById('zoom-cycle'); if(z&&z.checked)z.click();
    const btns=[...document.querySelectorAll('#panel button[data-n]')].map(b=>({b,n:+b.dataset.n})).sort((a,z)=>z.n-a.n);
    let rem=n; while(rem>0&&btns.length){const x=btns.find(y=>y.n<=rem)||btns[btns.length-1];x.b.click();rem-=x.n;}
  }, N);
  await page.waitForFunction(() => (window.__pool.getStats().inFlight||0)===0, { timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(2000);
  const out = await page.evaluate(async () => {
    const p = window.__pool, tier = p._batchedFarTier;
    if (!tier) return { err: 'no far tier created' };
    const ents = [...p._entities].filter(e=>!e._disposed && tier.instanceIdFor(e)>=0);
    if (!ents.length) return { err: 'no far entities', farCount: tier._instances.size };
    const e = ents[0], id = tier.instanceIdFor(e);
    let calls = 0; const orig = tier.mesh.setMatrixAt.bind(tier.mesh);
    tier.mesh.setMatrixAt = (...a)=>{ calls++; return orig(...a); };
    p.setTarget(e, e.root.position.x+8, e.root.position.y, e.root.position.z+8, 500);
    const usedGpuLerp = !p._movers.has(e);
    const callsAfterSet = calls;
    await new Promise(res=>{let i=0;const s=()=>{p.update();if(++i<60)requestAnimationFrame(s);else res();};requestAnimationFrame(s);});
    const callsDuringFlight = calls - callsAfterSet;
    const base = id*8, t = tier._lerpData;
    tier.mesh.setMatrixAt = orig;
    return { farCount: tier._instances.size, instanceId:id, usedGpuLerp, callsDuringFlight60: callsDuringFlight, lerp:{ p0:[t[base],t[base+1],t[base+2]], startT:+t[base+3].toFixed(2), p1:[t[base+4],t[base+5],t[base+6]], dur:t[base+7] } };
  });
  console.log('GPULERP_WITNESS ' + JSON.stringify({ ...out, glErrors: errs.filter(e=>e.includes('PAGEERR')||e.toLowerCase().includes('shader')||e.toLowerCase().includes('gl_')).slice(0,5) }));
} catch (e) { console.log('CHECK_ERROR ' + String(e&&e.stack||e)); }
finally { await browser.close(); }
