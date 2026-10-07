import { spawn } from 'child_process';
import fs from 'fs';
import { resolveLaunchArgs, assertLiveBackend } from './backend-guard.mjs';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const [dx, dy, dz, altKm] = process.argv.slice(2).map(Number);
const havePose = [dx, dy, dz].every(Number.isFinite);

function gpuLuids() {
  const vendor = process.env.GPU_VENDOR;
  const luid = process.env.GPU_LUID;
  return vendor && luid ? { [String(vendor).toLowerCase()]: luid } : {};
}

const CFG = [
  { name: 'd3d11',  port: 9231 },
  { name: 'vulkan', port: 9232 },
].map((b) => ({ ...b, launch: resolveLaunchArgs(b.name, process.env.GPU_VENDOR || null, gpuLuids()) }));

async function cdp(port) {
  const ver = await (await fetch(`http://localhost:${port}/json/version`)).json();
  const list = await (await fetch(`http://localhost:${port}/json`)).json();
  const pg = list.find(t => t.type === 'page' && t.url.includes('localhost:8080'));
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); });
  const { sessionId } = await send('Target.attachToTarget', { targetId: pg.id, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await fetch(`http://localhost:${port}/json/activate/${pg.id}`).catch(() => {});
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    return r.result.value; };
  return { evalIn, send, sessionId, ws };
}

const BROWSER_CLOSE_GRACE_MS = 1500;
const ORCH_READY_TIMEOUT_MS = 6 * 60 * 1000;

async function closeBrowser(port) {
  let ver = null;
  try { ver = await fetch(`http://localhost:${port}/json/version`).then((r) => r.json()); } catch { return false; }
  let ws = null;
  try {
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, BROWSER_CLOSE_GRACE_MS));
    return true;
  } catch { return false; }
  finally { try { ws.close(); } catch {} }
}

const POSE = havePose
  ? `const u0=[${dx},${dy},${dz}];const l0=Math.hypot(...u0);const land={u:[u0[0]/l0,u0[1]/l0,u0[2]/l0]};`
  : `let land=null;for(let i=0;i<3000&&!land;i++){const y=1-2*(i+0.5)/3000,rr=Math.sqrt(Math.max(0,1-y*y)),t=i*2.399963229;
       const u=[Math.cos(t)*rr,y,Math.sin(t)*rr];const h=sg(u);if(h>200&&h<900&&Math.abs(y)<0.5)land={u,h};}`;

async function measure(cfg) {
  const c = await cdp(cfg.port);
  try {
    const gpu = await assertLiveBackend(c.evalIn, cfg.launch, cfg.name);
    const readyBy = Date.now() + ORCH_READY_TIMEOUT_MS;
    for (;;) { const st = await c.evalIn(`window.__planetOrchStatus||'init'`).catch(() => 'nav');
      if (st === 'ready') break;
      if (st === 'error') throw new Error(`${cfg.name}: orch reported error`);
      if (Date.now() > readyBy) throw new Error(`${cfg.name}: orch not ready within ${ORCH_READY_TIMEOUT_MS} ms (last "${st}")`);
      await new Promise(r => setTimeout(r, 5000)); }
    const out = await c.evalIn(`(async()=>{
    const d=window.__diag; await d.probeWarm();
    const sg=window.__planetOrch.render.sampleGroundM;
    ${POSE}
    const camC=window.__dbg.cam,latC=Math.asin(land.u[1]),lonC=Math.atan2(land.u[0],land.u[2]);
    camC.sunLatBase=Math.max(-1.4,latC-0.5);camC.sunLonBase=lonC;camC.sunLonAccum=0;camC.timeScale=0;
    await d.aimDir(land.u, ${Number.isFinite(altKm) ? altKm : 2}, 50);
    const A=d._read(); let n=0,s=0,s2=0,grey=0;
    for(let i=0;i<A.px.length;i+=28){const r0=A.px[i],g0=A.px[i+1],b0=A.px[i+2];
      const lum=0.2126*r0+0.7152*g0+0.0722*b0;n++;s+=lum;s2+=lum*lum;
      const mx=Math.max(r0,g0,b0),mn=Math.min(r0,g0,b0);if(mx>30&&(mx-mn)<18)grey++;}
    const mean=s/n,sd=Math.sqrt(Math.max(0,s2/n-mean*mean));
    return {gpu:(window.__gpuRenderer||'').slice(0,70),lumMean:+mean.toFixed(1),lumSD:+sd.toFixed(2),greyFrac:+(grey/n).toFixed(3)};
  })()`);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' }, c.sessionId);
    fs.writeFileSync(`.gm/ab-${cfg.name}.png`, Buffer.from(shot.data, 'base64'));
    return { ...out, backend: gpu.backend, rasterizer: gpu.rasterizer, renderer: gpu.renderer };
  } finally {
    try { c.ws.close(); } catch {}
    await closeBrowser(cfg.port);
  }
}

const children = [];
for (const cfg of CFG) {
  children.push(spawn(CHROME, [`--user-data-dir=${process.cwd()}/.gm/tmp/ab-${cfg.name}`, `--remote-debugging-port=${cfg.port}`,
    '--no-first-run', '--no-default-browser-check', ...cfg.launch.args, 'http://localhost:8080/planet.html'],
    { detached: true, stdio: 'ignore' }).unref());
}
await new Promise(r => setTimeout(r, 8000));
const results = {};
const failures = [];
try {
  for (const cfg of CFG) {
    try { results[cfg.name] = await measure(cfg); }
    catch (e) { failures.push(`${cfg.name}: ${String((e && e.message) || e).slice(0, 300)}`); }
  }
} finally {
  for (const cfg of CFG) await closeBrowser(cfg.port);
  for (const ch of children) { try { ch.kill(); } catch {} }
}
if (failures.length) {
  console.error(`backend-ab: ${failures.length} arm(s) failed -- ${failures.join(' | ')}`);
  process.exit(1);
}
const dSD = Math.abs(results.d3d11.lumSD - results.vulkan.lumSD);
const dGrey = Math.abs(results.d3d11.greyFrac - results.vulkan.greyFrac);
console.log(JSON.stringify({ ...results,
  verdict: (dSD > 5 || dGrey > 0.15) ? 'BACKEND-DIVERGENT (suspect FXC translation -- see AGENTS.md FXC section)' : 'backends agree',
  screenshots: ['.gm/ab-d3d11.png', '.gm/ab-vulkan.png'] }, null, 1));