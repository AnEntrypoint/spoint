import { existsSync, statSync, realpathSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { getTransformedAsync, getTransformedHashAsync, getCachePath } from '../static/GLBTransformer.js'
import { getProgressive, resolveBakedFile } from '../static/ProgressiveBake.js'
import { getKtx2Extracted, resolveKtx2File } from '../static/KTX2Extract.js'
import { buildFetchManifest } from '../static/FetchManifest.js'
import { getServerIdentity } from '../sdk/ServerIdentity.js'
import {
  GZIP_EXTENSIONS, contentHashETag, isNodeModulesPath, getCached, getTransformedCached,
  prewarmCompression, serveRangeable
} from './StaticCache.js'

export { prewarmCompression }

function negotiateEncoding(req) {
  const ae = req.headers['accept-encoding'] || ''
  if (ae.includes('br')) return 'br'
  if (ae.includes('gzip')) return 'gzip'
  return null
}

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.vrm': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
  '.hf': 'application/octet-stream'
}

const CONTENT_HASHED_EXTENSIONS = new Set(['.hf'])

const RANGE_EXTENSIONS = new Set(['.glb', '.vrm', '.gltf', '.wasm', '.ktx2'])

const HASH_ETAG_EXTENSIONS = new Set(['.wasm', '.png', '.jpg', '.webp', '.ktx2', '.json', '.svg'])
const IMAGE_CACHE_CONTROL = 'public, max-age=300'
const JSON_CACHE_CONTROL = 'public, max-age=60'
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.webp', '.ktx2', '.svg', '.ico'])

function _notModifiedHeaders(headers) {
  const h = { 'ETag': headers['ETag'] }
  if (headers['Cache-Control']) h['Cache-Control'] = headers['Cache-Control']
  return h
}

const EARLY_HINTS_MAX = 12

function buildEarlyHintsLinks(manifest) {
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) return null
  const top = manifest.entries.slice(0, EARLY_HINTS_MAX)
  return top.map(e => `<${e.url}>; rel=preload; as=fetch; crossorigin`)
}

function computeAltSvc() {
  const raw = process.env.HTTP3_ALT_SVC
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/\bh3\b|\bh3-/.test(trimmed)) return trimmed
  const port = trimmed.replace(/^:/, '')
  if (!/^\d+$/.test(port)) {
    console.warn(`[http3] HTTP3_ALT_SVC="${raw}" is neither a bare port nor a literal Alt-Svc value (missing h3/h3- token) -- ignoring`)
    return null
  }
  return `h3=":${port}"; ma=86400`
}
const ALT_SVC_VALUE = computeAltSvc()

const COOP_VALUE = 'same-origin'
const COEP_VALUE = 'require-corp'

export function createStaticHandler(dirs, opts = {}) {
  const getWorldInfo = typeof opts.getWorldInfo === 'function' ? opts.getWorldInfo : null
  return async (req, res) => {
    if (ALT_SVC_VALUE) res.setHeader('Alt-Svc', ALT_SVC_VALUE)
    res.setHeader('Cross-Origin-Opener-Policy', COOP_VALUE)
    res.setHeader('Cross-Origin-Embedder-Policy', COEP_VALUE)
    const url = req.url.split('?')[0]
    if (url === '/__fetch-manifest.json') {
      if (!getWorldInfo) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('no world configured'); return }
      const { worldName, worldDef, project, sdkRoot } = getWorldInfo()
      if (!worldDef) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('world not loaded yet'); return }
      try {
        const manifest = await buildFetchManifest(worldName, worldDef, project, sdkRoot)
        const body = JSON.stringify(manifest)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate', 'Content-Length': Buffer.byteLength(body) })
        res.end(body)
      } catch (e) {
        console.error('[fetch-manifest] build error:', e?.message || e)
        res.writeHead(500, { 'Cache-Control': 'no-store' }); res.end('manifest build error')
      }
      return
    }
    if (url === '/favicon.ico') {
      res.writeHead(302, { Location: '/favicon.svg' })
      res.end()
      return
    }
    if (url === '/__identity') {
      const body = JSON.stringify(getServerIdentity(), null, 2)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    const progIdx = url.indexOf('.glb.prog/')
    if (progIdx >= 0) {
      const sourceUrl = url.slice(0, progIdx) + '.glb'
      const bakedRel = url.slice(progIdx + '.glb.prog/'.length)
      if (!bakedRel.includes('..')) for (const { prefix, dir } of dirs) {
        if (!sourceUrl.startsWith(prefix)) continue
        const srcPath = join(dir, sourceUrl.slice(prefix.length))
        if (!existsSync(srcPath) || !statSync(srcPath).isFile()) continue
        getProgressive(srcPath)
        const bakedFp = resolveBakedFile(srcPath, bakedRel)
        if (bakedFp) {
          const bExt = extname(bakedFp)
          const bakedMtime = statSync(bakedFp).mtimeMs
          const encoding = negotiateEncoding(req)
          const { content: body, encoding: usedEncoding, mtime } = await getCached(bakedFp, bExt, encoding)
          const contentHash = contentHashETag(bakedFp, body, mtime)
          const etag = `"${contentHash}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache, must-revalidate' })
            res.end()
            return
          }
          const hdr = {
            'Content-Type': MIME_TYPES[bExt] || 'application/octet-stream',
            'Cache-Control': 'no-cache, must-revalidate',
            'ETag': etag,
            'Vary': 'Accept-Encoding'
          }
          if (usedEncoding) hdr['Content-Encoding'] = usedEncoding
          if (RANGE_EXTENSIONS.has(bExt) && !usedEncoding) {
            serveRangeable(req, res, body, hdr)
            return
          }
          hdr['Content-Length'] = body.length
          res.writeHead(200, hdr)
          res.end(body)
          return
        }
        res.writeHead(404, { 'Cache-Control': 'no-store' })
        res.end('baking')
        return
      }
    }
    const ktx2Idx = url.indexOf('.glb.ktx2/')
    if (ktx2Idx >= 0) {
      const sourceUrl = url.slice(0, ktx2Idx) + '.glb'
      const rel = url.slice(ktx2Idx + '.glb.ktx2/'.length)
      const m = /^(\d+)\.ktx2$/.exec(rel)
      if (m) for (const { prefix, dir } of dirs) {
        if (!sourceUrl.startsWith(prefix)) continue
        const srcPath = join(dir, sourceUrl.slice(prefix.length))
        if (!existsSync(srcPath) || !statSync(srcPath).isFile()) continue
        getKtx2Extracted(srcPath)
        const ktx2Fp = resolveKtx2File(srcPath, m[1])
        if (ktx2Fp) {
          const encoding = negotiateEncoding(req)
          const { content: body, mtime } = await getCached(ktx2Fp, '.ktx2', null)
          const contentHash = contentHashETag(ktx2Fp, body, mtime)
          const etag = `"${contentHash}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache, must-revalidate' })
            res.end()
            return
          }
          const hdr = {
            'Content-Type': 'image/ktx2',
            'Cache-Control': 'no-cache, must-revalidate',
            'ETag': etag,
          }
          serveRangeable(req, res, body, hdr)
          return
        }
        res.writeHead(404, { 'Cache-Control': 'no-store' })
        res.end('extracting')
        return
      }
    }
    for (const { prefix, dir } of dirs) {
      if (!url.startsWith(prefix)) continue
      const relative = url === prefix ? '/index.html' : url.slice(prefix.length)
      const fp = join(dir, relative)
      const baseResolved = resolve(dir)
      const fpResolved = resolve(fp)
      if (fpResolved !== baseResolved && !fpResolved.startsWith(baseResolved + sep)) continue
      if (existsSync(fp) && statSync(fp).isFile()) {
        const isNodeModulesLink = fpResolved.includes(sep + 'node_modules' + sep)
        let realFp
        try { realFp = realpathSync(fp) } catch { continue }
        if (!isNodeModulesLink && realFp !== baseResolved && !realFp.startsWith(baseResolved + sep)) continue
        const ext = extname(fp)
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' }
        const isRevalidatable = ext === '.js' || ext === '.mjs' || ext === '.html' || ext === '.css'

        const skipEarlyHints = req.headers['x-spoint-edge-proxy'] === '1'
        if (ext === '.html' && getWorldInfo && !skipEarlyHints && typeof res.writeEarlyHints === 'function') {
          try {
            const { worldName, worldDef, project, sdkRoot } = getWorldInfo()
            if (worldDef) {
              const manifest = await buildFetchManifest(worldName, worldDef, project, sdkRoot)
              const link = buildEarlyHintsLinks(manifest)
              if (link) res.writeEarlyHints({ link })
            }
          } catch (e) {
            console.warn('[early-hints] skipped:', e?.message || e)
          }
        }

        if (isRevalidatable) {
          headers['Cache-Control'] = 'no-cache, must-revalidate'
        } else if (ext === '.glb' || ext === '.vrm' || ext === '.gltf' || ext === '.wasm' || CONTENT_HASHED_EXTENSIONS.has(ext)) {
          headers['Cache-Control'] = 'public, max-age=86400, immutable'
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          headers['Cache-Control'] = IMAGE_CACHE_CONTROL
        } else if (ext === '.json') {
          headers['Cache-Control'] = fp.endsWith('.shadermanifest.json') ? 'no-cache, must-revalidate' : JSON_CACHE_CONTROL
        }

        const wantsRange = !!req.headers['range'] && RANGE_EXTENSIONS.has(ext)

        if (ext === '.glb' || ext === '.vrm') {
          const srcMtime = statSync(fp).mtimeMs
          const transformed = await getTransformedAsync(fp)
          if (transformed) {
            const encoding = wantsRange ? null : negotiateEncoding(req)
            const contentHash = await getTransformedHashAsync(fp)
            headers['ETag'] = `"${contentHash || srcMtime.toString(16)}-opt"`
            headers['Vary'] = 'Accept-Encoding'
            const ifNoneMatch = req.headers['if-none-match']
            if (ifNoneMatch === headers['ETag']) {
              res.writeHead(304, _notModifiedHeaders(headers))
              res.end()
              return
            }
            const entry = await getTransformedCached(fp, srcMtime, transformed, encoding, contentHash ? { base: getCachePath(fp), hash: contentHash } : null)
            if (entry.encoding) headers['Content-Encoding'] = entry.encoding
            if (RANGE_EXTENSIONS.has(ext) && !entry.encoding) {
              serveRangeable(req, res, entry.content, headers)
              return
            }
            headers['Content-Length'] = entry.content.length
            res.writeHead(200, headers)
            res.end(entry.content)
            return
          }
        }

        const encoding = wantsRange ? null : negotiateEncoding(req)
        const { content, encoding: usedEncoding, mtime, raw } = await getCached(fp, ext, encoding)
        if (usedEncoding) headers['Content-Encoding'] = usedEncoding
        if (GZIP_EXTENSIONS.has(ext)) headers['Vary'] = 'Accept-Encoding'
        if (ext === '.glb' || ext === '.vrm' || ext === '.gltf' || isRevalidatable || CONTENT_HASHED_EXTENSIONS.has(ext) || HASH_ETAG_EXTENSIONS.has(ext)) {
          headers['ETag'] = (isNodeModulesPath(fpResolved) || CONTENT_HASHED_EXTENSIONS.has(ext) || HASH_ETAG_EXTENSIONS.has(ext))
            ? `"${contentHashETag(fp, raw, mtime)}"`
            : `"${mtime.toString(16)}"`
          const ifNoneMatch = req.headers['if-none-match']
          if (ifNoneMatch === headers['ETag']) {
            res.writeHead(304, _notModifiedHeaders(headers))
            res.end()
            return
          }
        }
        if (RANGE_EXTENSIONS.has(ext) && !usedEncoding) {
          serveRangeable(req, res, content, headers)
          return
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
