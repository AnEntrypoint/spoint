import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.vrm': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm'
}

export function createStaticHandler(dirs) {
  return (req, res) => {
    const url = req.url.split('?')[0]
    for (const { prefix, dir } of dirs) {
      if (!url.startsWith(prefix)) continue
      const relative = url === prefix ? '/index.html' : url.slice(prefix.length)
      const fp = join(dir, relative)
      if (existsSync(fp)) {
        const ext = extname(fp)
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' }
        if (ext === '.js' || ext === '.html' || ext === '.css') {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        }
        res.writeHead(200, headers)
        res.end(readFileSync(fp))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  }
}
