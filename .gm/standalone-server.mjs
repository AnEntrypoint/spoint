import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8099;
const HOST = '127.0.0.1';
const root = path.resolve('C:/dev/spoint/.gm');
const origGlbPath = 'C:/dev/maps/compress/output/aim_sillos.glb';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary' };

const resolveInRoot = (urlPath) => {
  const resolved = path.resolve(root, `.${urlPath}`);
  return resolved.startsWith(root + path.sep) ? resolved : null;
};

http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/standalone-viewer.html';
  let filePath;
  if (p === '/original-sillos.glb') {
    filePath = origGlbPath;
  } else {
    filePath = resolveInRoot(p);
    if (filePath === null) { res.writeHead(404); res.end('not found'); return; }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, HOST, () => console.log('standalone server on', PORT));
