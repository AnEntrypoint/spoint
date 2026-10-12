import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const gmDir = path.join(projectRoot, '.gm');
const outDir = path.join(gmDir, 'witness-out');
const logPath = path.join(gmDir, 'witness-log.md');
const defaultModule = path.join(gmDir, 'standalone-server.mjs');
const EXPECTED_PORT = 8099;
const DEFAULT_ORIG_GLB = 'C:/dev/maps/compress/output/aim_sillos.glb';
const ORIG_GLB_ENV = 'SPOINT_ORIG_GLB';
const EXPECTED_CHECKS = 21;
const UNAVAILABLE = 'no listening server';

const argValue = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

const modulePath = path.resolve(argValue('module') ?? defaultModule);
const row = argValue('row') ?? 'unassigned';
const session = argValue('session') ?? 'unassigned';
const kind = modulePath === path.resolve(defaultModule) ? 'honest' : fs.existsSync(modulePath) ? 'mutant' : 'missing';

const ORIG_GLB = path.resolve(argValue('orig-glb') ?? process.env[ORIG_GLB_ENV] ?? DEFAULT_ORIG_GLB);
process.env[ORIG_GLB_ENV] = ORIG_GLB;

const startedAt = new Date().toISOString();
const stamp = `${startedAt.replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');
const text = (response) => response.body.toString('utf8');
const summarize = (response) => ({ status: response.status, type: response.type, sha256: sha256(response.body) });
const observe = (response, select) => (response === null ? UNAVAILABLE : select(response));
const routeOf = (response, label) => (response === null ? `${label} unavailable` : summarize(response));

const lines = [];
const results = [];
const record = (name, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ name, ok });
  lines.push(`CHECK ${String(results.length).padStart(2, '0')} ${name} ${ok ? 'PASS' : 'FAIL'} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
};

const servers = [];
const requestedPorts = [];
const createServerOriginal = http.createServer;
http.createServer = function createServerRecorded(...args) {
  const server = createServerOriginal.apply(this, args);
  servers.push(server);
  return server;
};
const requestedHosts = [];
const listenOriginal = http.Server.prototype.listen;
http.Server.prototype.listen = function listenOnEphemeralPort(...args) {
  if (typeof args[0] === 'number') {
    requestedPorts.push(args[0]);
    args[0] = 0;
  }
  if (typeof args[1] === 'string') requestedHosts.push(args[1]);
  return listenOriginal.apply(this, args);
};

const logged = [];
const consoleLogOriginal = console.log;
console.log = (...args) => {
  logged.push(args.map(String).join(' '));
};

const fetchFrom = (port, urlPath) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false, headers: { Connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'],
            cors: res.headers['access-control-allow-origin'],
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error(`timeout ${urlPath}`)));
    req.on('error', reject);
    req.end();
  });

const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
};

const closeServers = async () => {
  for (const server of servers) {
    if (!server.listening) continue;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
};

const loadModule = async () => {
  if (!fs.existsSync(modulePath)) return `module path missing: ${modulePath}`;
  try {
    await import(pathToFileURL(modulePath).href);
    return null;
  } catch (error) {
    return `module import threw: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const runChecks = async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const probeName = `standalone-server-probe-${stamp}.html`;
  const probeBody = `<!doctype html>\n<p>standalone-server-witness probe ${stamp}</p>\n`;
  fs.writeFileSync(path.join(outDir, probeName), probeBody, { flag: 'wx' });

  const loadError = await loadModule();
  if (loadError !== null) lines.push(`ERROR ${loadError}`);
  record('module-loads', true, loadError === null);

  if (loadError === null) await waitUntil(() => servers.length > 0 && servers[0].listening && logged.length > 0, 5000);
  record('http-server-created-once', 1, servers.length);
  record('listen-requested-port', [EXPECTED_PORT], requestedPorts);
  record('listen-log-line', true, logged.includes(`standalone server on ${EXPECTED_PORT}`));

  const port = servers.length > 0 && servers[0].listening ? servers[0].address().port : null;
  const probeUrl = `/witness-out/${probeName}`;
  const probe = port === null ? null : await fetchFrom(port, probeUrl);
  const probeQuery = port === null ? null : await fetchFrom(port, `${probeUrl}?run=${stamp}`);
  const root = port === null ? null : await fetchFrom(port, '/');
  const viewer = port === null ? null : await fetchFrom(port, '/standalone-viewer.html');
  const missingName = `missing-${stamp}.txt`;
  const missing = port === null ? null : await fetchFrom(port, `/witness-out/${missingName}`);
  const glb = port === null ? null : await fetchFrom(port, '/original-sillos.glb');

  record('probe-status', 200, observe(probe, (r) => r.status));
  record('probe-content-type', 'text/html', observe(probe, (r) => r.type));
  record('probe-cors', null, observe(probe, (r) => r.cors ?? null));
  record('probe-body', probeBody, observe(probe, text));
  record('query-stripped', { status: 200, body: probeBody }, observe(probeQuery, (r) => ({ status: r.status, body: text(r) })));
  record('root-matches-viewer', routeOf(viewer, 'viewer'), routeOf(root, 'root'));
  record('missing-status', 404, observe(missing, (r) => r.status));
  record('missing-body', `not found: ${path.join(gmDir, 'witness-out', missingName)}`, observe(missing, text));

  const glbExists = fs.existsSync(ORIG_GLB);
  lines.push(
    `NOTE original-glb-route exercises the ${glbExists ? '200' : '404'} branch: ${ORIG_GLB} is ${
      glbExists ? 'present' : 'absent on this machine'
    }${glbExists ? '' : `; set ${ORIG_GLB_ENV} or pass --orig-glb=<path> to exercise the 200 branch`}`,
  );
  const glbExpected = glbExists
    ? { status: 200, type: 'model/gltf-binary', sha256: sha256(fs.readFileSync(ORIG_GLB)) }
    : { status: 404, body: `not found: ${ORIG_GLB}` };
  const glbActual = observe(glb, (r) =>
    r.status === 200 ? { status: 200, type: r.type, sha256: sha256(r.body) } : { status: r.status, body: text(r) },
  );
  record('original-glb-route', glbExpected, glbActual);

  const bound = servers.length > 0 && servers[0].listening ? servers[0].address() : null;
  record('listen-requested-host', ['127.0.0.1'], requestedHosts);
  record('bound-address-loopback', '127.0.0.1', bound === null ? UNAVAILABLE : bound.address);

  const escapes = [
    ['escape-raw-dotdot-agents', '/../AGENTS.md'],
    ['escape-encoded-dotdot-agents', '/%2e%2e/AGENTS.md'],
    ['escape-encoded-backslash-agents', '/%2e%2e%5cAGENTS.md'],
    ['escape-mixed-slash-agents', '/..%2fAGENTS.md'],
    ['escape-raw-win-ini', '/../../../Windows/win.ini'],
  ];
  for (const [name, urlPath] of escapes) {
    const response = port === null ? null : await fetchFrom(port, urlPath);
    record(name, 404, observe(response, (r) => r.status));
  }

  await closeServers();
  record('server-closed', true, servers.length === 1 && servers.every((server) => !server.listening));
};

let fatal = null;
try {
  await runChecks();
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  lines.push(`ERROR ${fatal}`);
} finally {
  try {
    await closeServers();
  } catch (error) {
    lines.push(`ERROR close ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log = consoleLogOriginal;
}

const failed = results.filter((result) => !result.ok);
const complete = results.length === EXPECTED_CHECKS;
const verdict = fatal === null && complete && failed.length === 0 ? 'PASS' : 'FAIL';
const firstFailed = failed.length > 0 ? failed[0].name : complete ? 'none' : 'checks-incomplete';
lines.push(`CHECKS executed=${results.length} expected=${EXPECTED_CHECKS} failed=${failed.length}`);

const header = [
  `witness standalone-server-witness kind=${kind} row=${row} session=${session} run=${stamp}`,
  `module ${modulePath}`,
  `started ${startedAt}`,
];
const reportPath = path.join(outDir, `standalone-server-${kind}-${stamp}.txt`);
let written = null;
try {
  fs.writeFileSync(reportPath, [...header, ...lines, `RESULT: ${verdict}`].join('\n') + '\n', { flag: 'wx' });
  written = { digest: sha256(fs.readFileSync(reportPath)), relOut: toPosix(path.relative(projectRoot, reportPath)) };
} catch (error) {
  lines.push(`ERROR report ${error instanceof Error ? error.message : String(error)}`);
}

const digest = written === null ? 'none' : written.digest;
const relOut = written === null ? 'none' : written.relOut;
let finalVerdict = written === null ? 'FAIL' : verdict;
try {
  fs.appendFileSync(
    logPath,
    `- row ${row} | witness standalone-server-witness ${kind} | run ${stamp} | exit ${finalVerdict === 'PASS' ? 0 : 1} | RESULT: ${finalVerdict} checks=${results.length} failed=${failed.length} first=${firstFailed} | ${startedAt} | out ${relOut} | sha256 ${digest} | session ${session}\n`,
  );
} catch (error) {
  finalVerdict = 'FAIL';
  lines.push(`ERROR log ${error instanceof Error ? error.message : String(error)}`);
}

process.stdout.write([...lines, `output ${relOut}`, `sha256 ${digest}`, `RESULT: ${finalVerdict}`].join('\n') + '\n');
process.exitCode = finalVerdict === 'PASS' ? 0 : 1;
