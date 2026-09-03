import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8099;
const root = 'C:/dev/spoint/.gm';
const origGlbPath = 'C:/dev/maps/compress/output/aim_sillos.glb';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary' };

http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/standalone-viewer.html';
  let filePath;
  if (p === '/original-sillos.glb') {
    filePath = origGlbPath;
  } else {
    filePath = path.join(root, p);
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}).listen(PORT, () => console.log('standalone server on', PORT));
