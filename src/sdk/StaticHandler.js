import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { gzipSync } from 'node:zlib'

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.vrm': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon'
}

const GZIP_EXTENSIONS = new Set(['.glb', '.vrm', '.gltf', '.js', '.css', '.html', '.json'])

export function createStaticHandler(dirs) {
  return (req, res) => {
    const url = req.url.split('?')[0]
    if (url === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    for (const { prefix, dir } of dirs) {
      if (!url.startsWith(prefix)) continue
      const relative = url === prefix ? '/index.html' : url.slice(prefix.length)
      const fp = join(dir, relative)
      if (existsSync(fp) && statSync(fp).isFile()) {
        const ext = extname(fp)
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' }
        if (ext === '.js' || ext === '.html' || ext === '.css') {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        } else if (ext === '.glb' || ext === '.vrm' || ext === '.gltf') {
          headers['Cache-Control'] = 'public, max-age=86400, immutable'
        }
        let content = readFileSync(fp)
        if (GZIP_EXTENSIONS.has(ext) && content.length > 100) {
          content = gzipSync(content)
          headers['Content-Encoding'] = 'gzip'
        }
        headers['Content-Length'] = content.length
        res.writeHead(200, headers)
        res.end(content)
        return
      }
    }
    res.writeHead(404, { 'Cache-Control': 'no-store' })
    res.end('not found')
  }
}
