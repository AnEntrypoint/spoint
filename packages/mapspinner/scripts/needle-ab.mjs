// needle-ab.mjs -- backend A/B for the patch-bake "height needle" defect (2026-07-04): isolated
// single-texel +30m spikes in bakeTile output, deterministic + world-anchored, absent from the
// float64 CPU mirror. If the needles vanish on a different ANGLE translator (swiftshader/vulkan)
// they are the documented FXC mis-translation class; if they persist everywhere they are genuine
// fp32 math in the fractal. Follows backend-ab.mjs's CDP pattern; needs no planet.html boot --
// bakes a known-bad tile directly through patch-baker on a bare served page.
//
//   node scripts/needle-ab.mjs          # d3d11 (default ANGLE) vs swiftshader vs vulkan
//
// Known-bad tile (witnessed in the consumer world, radius 63600, reliefScale 0.001, no seed):
// face=4, patchSpan=801.2109375, pi=-72, pj=33 -> outlier texels (71,6),(70,12),(69,18),(59,77),(53,112).
import { spawn } from 'child_process';
import fs from 'fs';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const PORT = 8084;
const ALL = [
  { name: 'd3d11',       port: 9241, args: [] },
  { name: 'swiftshader', port: 9242, args: ['--use-angle=swiftshader'] },
  { name: 'vulkan',      port: 9243, args: ['--use-angle=vulkan'] },
];
const CFG = process.env.BACKENDS ? ALL.filter(b => process.env.BACKENDS.split(',').includes(b.name)) : ALL;

const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let k = 0; k < 30; k++) {
  const ok = await fetch(`http://localhost:${PORT}/src/patch-baker.js`).then(r => r.ok).catch(() => false);
  if (ok) break;
  await new Promise(r => setTimeout(r, 500));
}

async function cdp(port) {
  let ver = null;
  for (let k = 0; k < 30 && !ver; k++) {
    ver = await fetch(`http://localhost:${port}/json/version`).then(r => r.json()).catch(() => null);
    if (!ver) await new Promise(r => setTimeout(r, 500));
  }
  if (!ver) throw new Error('chrome debug port never came up');
  const list = await (await fetch(`http://localhost:${port}/json`)).json();
  const pg = list.find(t => t.type === 'page');
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
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: `http://localhost:${PORT}/src/patch-baker.js` }, sessionId);
  await new Promise(r => setTimeout(r, 2000));
  await send('Runtime.enable', {}, sessionId);
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
    return r.result.value; };
  return { evalIn, ws };
}

const BAKE_EXPR = `(async () => {
  const mod = await import(location.origin + '/src/patch-baker.js');
  const baker = await mod.createPatchBaker({ radius: 63600, reliefScale: 0.001 });
  if (!baker) return { err: 'baker null (no webgl2/float ext on this backend?)' };
  const span = 801.2109375, res = baker.res;
  // FXC cold compile of the bake program can take 30-90s; poll instead of trusting one bounded retry.
  let h = null;
  const until = Date.now() + 120000;
  while (!h && Date.now() < until) { h = baker.bakeTile(4, -72 * span, 33 * span, span, 0); if (!h) await new Promise(r => setTimeout(r, 2000)); }
  if (!h) return { err: 'bake null after 120s' };
  const out = [];
  for (let j = 1; j < res - 1; j++) for (let i = 1; i < res - 1; i++) {
    const v = h[j * res + i];
    const m = (h[j * res + i - 1] + h[j * res + i + 1] + h[(j - 1) * res + i] + h[(j + 1) * res + i]) / 4;
    if (Math.abs(v - m) > 8) out.push([i, j, +v.toFixed(1), +m.toFixed(1)]);
  }
  const glInfo = (() => { try { const c = new OffscreenCanvas(4,4).getContext('webgl2');
    const ext = c.getExtension('WEBGL_debug_renderer_info');
    return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER); } catch(e){ return String(e); } })();
  return { renderer: glInfo, nOutliers: out.length, outliers: out.slice(0, 10) };
})()`;

for (const b of CFG) {
  const prof = `${process.env.TEMP || '/tmp'}/needle-ab-${b.name}-${Date.now()}`;
  const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${b.port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu-sandbox', ...b.args, 'about:blank'], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 2500));
    const c = await cdp(b.port);
    const out = await c.evalIn(BAKE_EXPR);
    console.log(b.name, JSON.stringify(out));
    c.ws.close();
  } catch (e) { console.log(b.name, 'ERR', String(e).slice(0, 300)); }
  ch.kill();
}
server.kill();
