import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs';

await installSpecifierHooks();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src/sdk/AgentAuthoringAPI.js');
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
};

const source = readFileSync(SOURCE, 'utf8');
check('AgentAuthoringAPI imports timingSafeTokenEqual from authCompare', /import \{[^}]*\btimingSafeTokenEqual\b[^}]*\} from '\.\/authCompare\.js'/.test(source));
check('the x-agent-token header is compared through timingSafeTokenEqual', /timingSafeTokenEqual\(\s*req\.headers\['x-agent-token'\]\s*,\s*token\s*\)/.test(source));
check('no raw !== comparison of the agent token remains', !/req\.headers\['x-agent-token'\]\s*!==/.test(source));

process.env.SPOINT_AGENT_TOKEN = 'witness-agent-token-0123456789';
const { createAgentAuthoringHandler } = await import(pathToFileURL(SOURCE).href);
const handler = createAgentAuthoringHandler();
const appRuntime = { _appDefs: new Map([['alpha', {}]]), entities: new Map() };

const run = async (headers) => {
  const res = { statusCode: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(status, h) { this.statusCode = status; Object.assign(this.headers, h || {}) }, end(b = '') { this.body += b; return this } };
  const req = { method: 'GET', url: '/agent/apps', headers, socket: { remoteAddress: '127.0.0.1' } };
  await handler(req, res, appRuntime, {});
  return { status: res.statusCode, body: res.body };
};

const wrong = await run({ 'x-agent-token': 'witness-agent-token-0123456789-x' });
check('a wrong token is refused with agent-token-mismatch', wrong.status === 403 && wrong.body.includes('agent-token-mismatch'), `status=${wrong.status}`);
const missing = await run({});
check('a missing token is refused with agent-token-mismatch', missing.status === 403 && missing.body.includes('agent-token-mismatch'), `status=${missing.status}`);
const right = await run({ 'x-agent-token': 'witness-agent-token-0123456789' });
check('the right token reaches the route', right.status === 200 && right.body.includes('alpha'), `status=${right.status}`);

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? 'RESULT: PASS agent route token is compared in constant time and enforced' : `RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
