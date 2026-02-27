import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { getTransformed } from '../static/GLBTransformer.js'

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.vrm': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon'
}

const GZIP_EXTENSIONS = new Set(['.glb', '.vrm', '.gltf', '.js', '.css', '.html', '.json'])
const fileCache = new Map()
// Separate cache for transformed GLBs (keyed by fp, value: {srcMtime, content, gzipped})
const transformedCache = new Map()

function getCached(fp, ext) {
  const mtime = statSync(fp).mtimeMs
  const key = fp
  const cached = fileCache.get(key)
  if (cached && cached.mtime === mtime) return cached
  let raw = readFileSync(fp)
  const shouldGzip = GZIP_EXTENSIONS.has(ext) && raw.length > 100
  const content = shouldGzip ? gzipSync(raw) : raw
  const entry = { mtime, content, gzipped: shouldGzip }
  fileCache.set(key, entry)
  return entry
}

function getTransformedCached(fp, srcMtime, rawBuffer) {
  const cached = transformedCache.get(fp)
  if (cached && cached.srcMtime === srcMtime) return cached
  const content = gzipSync(rawBuffer)
  const entry = { srcMtime, content, gzipped: true }
  transformedCache.set(fp, entry)
  return entry
}

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

        // For GLB files, try to serve transformed (KTX2+Draco) version
        if (ext === '.glb') {
          const srcMtime = statSync(fp).mtimeMs
          const transformed = getTransformed(fp)
          if (transformed) {
            // Serve optimized version
            const entry = getTransformedCached(fp, srcMtime, transformed)
            headers['Content-Encoding'] = 'gzip'
            headers['Content-Length'] = entry.content.length
            headers['ETag'] = `"${srcMtime.toString(16)}-opt"`
            const ifNoneMatch = req.headers['if-none-match']
            if (ifNoneMatch === headers['ETag']) {
              res.writeHead(304, { 'ETag': headers['ETag'], 'Cache-Control': headers['Cache-Control'] })
              res.end()
              return
            }
            res.writeHead(200, headers)
            res.end(entry.content)
            return
          }
          // Fall through to serve original while transform runs in background
        }

        const { content, gzipped, mtime } = getCached(fp, ext)
        if (gzipped) headers['Content-Encoding'] = 'gzip'
        headers['Content-Length'] = content.length
        if (ext === '.glb' || ext === '.vrm' || ext === '.gltf') {
          headers['ETag'] = `"${mtime.toString(16)}"`
          const ifNoneMatch = req.headers['if-none-match']
          if (ifNoneMatch === headers['ETag']) {
            res.writeHead(304, { 'ETag': headers['ETag'], 'Cache-Control': headers['Cache-Control'] })
            res.end()
            return
          }
        }
        res.writeHead(200, headers)
        res.end(content)
        return
      }
    }
    res.writeHead(404, { 'Cache-Control': 'no-store' })
    res.end('not found')
  }
}
