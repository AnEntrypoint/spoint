// verify.mjs -- permanent make-sure-it-works runner (2026-06-11 policy: every render/shader
// fix is verified against the LIVE page before commit; compile-clean alone never ships).
//
// Drives the in-page witness suite (window.__diag.verifyAll / coastWitness / materialWitness /
// shadeKeyWitness / limbScan / hazeProbe ... in planet.html) over RAW CDP using Node's built-in
// WebSocket -- no relay, no per-call execution cap, no session recycling, zero dependencies.
//
// Usage:
//   node scripts/verify.mjs                  # full suite (__diag.verifyAll)
//   node scripts/verify.mjs materialWitness  # one probe
//   node scripts/verify.mjs "expr"           # any expression on the planet page (await'ed)
// Needs: dev server on :8080 and a chrome with --remote-debugging-port=9222 (headless ok):
//   chrome --headless=new --remote-debugging-port=9222 --user-data-dir=.gm/.cdp-profile about:blank
// Exit code 0 = pass, 1 = fail/error. Prints the JSON verdict.

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

// wait for the orchestrator (cold shader compile can take minutes on SwiftShader)
const deadline = Date.now() + 8 * 60 * 1000;
// Close the created page on EVERY exit path (perf sweep follow-up 2026-06-11: early-exit/killed runs
// leaked one headless planet.html per run; leaked pages poll /cmd and steal live-tab diagnostics).
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
