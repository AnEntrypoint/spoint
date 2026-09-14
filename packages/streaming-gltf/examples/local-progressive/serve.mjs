#!/usr/bin/env node

import { createServer } from 'node:http';
import { stat, open, readdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname);
const PORT = Number(process.env.PORT) || 5180;
const GLB_FIXED_DIR = resolve(process.env.GLB_FIXED_DIR || 'C:/dev/maps/output/glb_fixed');
const CLUSTER_DIR = resolve(process.env.CLUSTER_DIR || '../../../assets/streaming-cluster');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.glb':  'model/gltf-binary',
  '.webp': 'image/webp',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.css':  'text/css',
};

createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/stress.html';
    if (urlPath === '/assets-list.json') {
      const entries = await readdir(CLUSTER_DIR, { withFileTypes: true }).catch(() => []);
      const list = entries
        .filter((e) => e.isFile() && e.name.endsWith('.cluster.glb'))
        .map((e) => ({ path: `/cluster/${e.name}` }))
        .sort((a, b) => a.path.localeCompare(b.path));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(list));
      return;
    }
    if (urlPath === '/glb_fixed-list.json') {
      const entries = await readdir(GLB_FIXED_DIR, { withFileTypes: true }).catch(() => []);
      const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.glb'))
        .map((e) => e.name)
        .sort();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(files));
      return;
    }

    let base = ROOT;
    if (urlPath.startsWith('/glb_fixed/')) {
      base = GLB_FIXED_DIR;
      urlPath = urlPath.slice('/glb_fixed'.length);
    } else if (urlPath.startsWith('/cluster/')) {
      base = CLUSTER_DIR;
      urlPath = urlPath.slice('/cluster'.length);
    } else if (urlPath.startsWith('/src/')) {
      base = resolve(__dirname, '../../src');
      urlPath = urlPath.slice('/src'.length);
    }
    const full = normalize(join(base, urlPath));
    if (!full.startsWith(base)) { res.writeHead(403).end('forbidden'); return; }

    const s = await stat(full).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('not found'); return; }

    const mime = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] === '' ? Math.max(0, s.size - Number(m[2])) : Number(m[1]);
        const end = m[2] === '' ? s.size - 1 : Math.min(Number(m[2]), s.size - 1);
        if (start <= end && start < s.size) {
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${s.size}`,
            'Content-Length': end - start + 1,
          });
          const fh = await open(full, 'r');
          fh.createReadStream({ start, end }).pipe(res);
          return;
        }
      }
    }

    res.setHeader('Content-Length', s.size);
    const fh = await open(full, 'r');
    fh.createReadStream().pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}/`);
});
