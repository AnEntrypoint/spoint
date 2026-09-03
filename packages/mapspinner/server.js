import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
// Static file server for the GPU one-fractal planet (planet.html + src/*.js + shaders/*.glsl).
// No native binary, no capture/diag sinks (the old GPU-capture pipeline is deleted).
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',   // ES module imports require a JS MIME (browser rejects octet-stream)
  '.json': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
  '.glsl': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Set COOP/COEP headers for SharedArrayBuffer support
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Disable caching so iterative dev edits show up on reload
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const urlPath = req.url.split('?')[0];

  // DIAG SINK (re-hosted 2026-06-07, user: 'it wants to contact /diag, we're missing diagnostic info by
  // not hosting that'). planet.html postDiag() POSTs a per-frame JSON line; without a handler it 404s and
  // the live diagnostic stream is lost. The last 200 lines are kept in an in-memory ring so a headless
  // agent can GET /diag/tail and read the live render state (face/alt/quads/glError/height) WITHOUT a
  // browser tool. (The old capture/diag.ndjson file append was a dead ENOENT no-op after capture/ was
  // deleted in c131284 -- removed 2026-06-11; the ring is the only consumer anyone reads.)
  if (urlPath === '/diag' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const line = body.trim();
        if (line) {
          server._diagRing = server._diagRing || [];
          server._diagRing.push(line);
          if (server._diagRing.length > 200) server._diagRing.shift();
        }
      } catch (_) {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (urlPath === '/diag/tail') {
    const ring = server._diagRing || [];
    const n = Math.min(ring.length, parseInt((req.url.split('?')[1] || '').replace(/^n=/, '')) || 30);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.end(ring.slice(-n).join('\n') + '\n');
    return;
  }
  if (urlPath === '/diag/clear') { server._diagRing = []; res.writeHead(204); res.end(); return; }

  // AGENT COMMAND CHANNEL (2026-06-07, user: 'maximize live code execution + hot reloading'). Lets a
  // headless agent drive the warm tab WITHOUT a reload or browser tool: POST /cmd {js} enqueues a JS
  // snippet; the page polls GET /cmd/next, runs it, and POSTs the result to /diag (kind:'cmd-result').
  // So toggling the atlas, hot-reloading the shader (window.__diag.recompile), and probing live state
  // are all one curl away -- the simplest possible iterate loop given the cold compile blocks the tool.
  if (urlPath === '/cmd' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { const o = JSON.parse(body); server._cmdQ = server._cmdQ || []; server._cmdQ.push({ id: (server._cmdId = (server._cmdId || 0) + 1), js: o.js }); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ queued: server._cmdId })); }
      catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  if (urlPath === '/cmd/next') {
    const q = server._cmdQ || [];
    const cmd = q.shift() || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cmd));
    return;
  }
  // Root IS the GPU planet (planet.html): one-fractal terrain on WebGL. /rewrite.html
  // kept as an alias. Everything else falls through to a static file (src/, shaders, etc.).
  let filepath;
  if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/rewrite.html' || urlPath === '/rewrite') {
    filepath = path.join(__dirname, 'planet.html');
  } else {
    filepath = path.join(__dirname, urlPath);
  }

  // Prevent directory traversal
  if (!filepath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filepath, (err, stats) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    if (stats.isDirectory()) {
      filepath = path.join(filepath, 'index.html');
    }

    const ext = path.extname(filepath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filepath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Server Error');
        return;
      }

      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
