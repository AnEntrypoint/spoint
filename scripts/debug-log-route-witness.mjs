import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`) };
const finish = (label, pass) => { const failed = checks.filter((c) => !c.ok); console.log(failed.length === 0 ? `RESULT: PASS ${label}` : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`); process.exitCode = failed.length === 0 ? 0 : 1 };
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { handleDebugLog } = await mod('src/sdk/ServerAPIRoutes.js');
const origLog = console.log;
console.log = () => {};
const makeReq = (remote, headers, bodyChunks) => {
  const req = new EventEmitter();
  req.socket = { remoteAddress: remote };
  req.headers = headers;
  req.destroy = () => {};
  req.send = () => { for (const c of bodyChunks) req.emit('data', Buffer.from(c)); req.emit('end') };
  return req;
};
const makeRes = () => ({ statusCode: 0, body: '', writeHead(s) { this.statusCode = s }, end(b = '') { this.body += b } });
const post = (remote, headers, chunks) => { const req = makeReq(remote, headers, chunks); const res = makeRes(); handleDebugLog(req, res); req.send(); return res };
const body = ['["hello"]'];
try {
  delete process.env.EDITOR_TOKEN;
  check('a non-loopback peer without EDITOR_TOKEN is refused', post('203.0.113.7', {}, body).statusCode === 403);
  process.env.EDITOR_TOKEN = 'witness-editor-token-0123';
  check('a non-loopback peer with a wrong token is refused', post('203.0.113.8', { 'x-editor-token': 'nope' }, body).statusCode === 403);
  check('a non-loopback peer with the right token is accepted', post('203.0.113.9', { 'x-editor-token': 'witness-editor-token-0123' }, body).statusCode === 200);
  const burst = [];
  for (let i = 0; i < 21; i++) burst.push(post('::1', {}, body).statusCode);
  check('a loopback peer gets a 20-request burst then 429', burst.slice(0, 20).every((s) => s === 200) && burst[20] === 429, burst.join(','));
  check('an oversized body is refused with 413', post('127.0.0.1', {}, [Buffer.alloc(256 * 1024 + 1, 0x61).toString()]).statusCode === 413);
} finally { console.log = origLog }
finish('debug-log route: loopback-or-token, 20-burst rate limit, 256 KB cap', true);
