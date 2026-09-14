const CDP_HTTP = process.env.CDP_URL || 'http://localhost:9222';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:8080/planet.html';
const probe = process.argv[2] || 'verifyAll';

const ver = await (await fetch(CDP_HTTP + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result); }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

const { targetId } = await send('Target.createTarget', { url: PAGE_URL });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);

const evalIn = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result.value;
};

const ORCH_READY_TIMEOUT_MS = 8 * 60 * 1000;
const deadline = Date.now() + ORCH_READY_TIMEOUT_MS;
const closeTarget = () => send('Target.closeTarget', { targetId }).catch(() => {});
process.on('SIGINT', async () => { await closeTarget(); process.exit(130); });
process.on('SIGTERM', async () => { await closeTarget(); process.exit(143); });
for (;;) {
  const st = await evalIn('window.__planetOrchStatus || "init"', false).catch(() => 'navigating');
  if (st === 'ready') break;
  if (st === 'error') { console.log(JSON.stringify({ pass: false, err: 'orch-error' })); await closeTarget(); process.exit(1); }
  if (Date.now() > deadline) { console.log(JSON.stringify({ pass: false, err: 'ready-timeout' })); await closeTarget(); process.exit(1); }
  await new Promise(r => setTimeout(r, 4000));
}

const expr = /^[A-Za-z]\w*$/.test(probe)
  ? `window.__diag.${probe}()`
  : probe;
let verdict;
try { verdict = await evalIn(`(async()=>{ const r = await (${expr}); return r; })()`); }
catch (e) { verdict = { pass: false, err: String(e.message || e).slice(0, 500) }; }

await closeTarget();
console.log(JSON.stringify(verdict, null, 1));
process.exit(verdict && (verdict.pass || verdict.ok) ? 0 : 1);
