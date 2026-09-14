import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const DIAG_RING_MAX_LINES = 200;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
  '.glsl': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const urlPath = req.url.split('?')[0];

  if (urlPath === '/diag' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const line = body.trim();
        if (line) {
          server._diagRing = server._diagRing || [];
          server._diagRing.push(line);
          if (server._diagRing.length > DIAG_RING_MAX_LINES) server._diagRing.shift();
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
  let filepath;
  if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/rewrite.html' || urlPath === '/rewrite') {
    filepath = path.join(__dirname, 'planet.html');
  } else {
    filepath = path.join(__dirname, urlPath);
  }

  const escapesServeRoot = !filepath.startsWith(__dirname);
  if (escapesServeRoot) {
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
