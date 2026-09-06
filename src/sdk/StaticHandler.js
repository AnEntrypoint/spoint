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

// Re-exported from StaticCache.js for backward compatibility -- server.js/ServerBoot.js imports
// prewarmCompression from this file's own path.
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
  // .hf = scripts/bake-heightfield.mjs's binary sector-quantized heightfield artifact (mapspinner
  // heightfield-codec). No registered IANA type, application/octet-stream is the honest generic binary type.
  '.hf': 'application/octet-stream'
}

// Baked heightfield tiles (.hf, see scripts/bake-heightfield.mjs + AGENTS.md's
// cdn-hosted-baked-heightfield-tiles-static row): content-addressable exactly like GLB/VRM below --
// re-baking the identical terrain params (glsl/anchorDir/radius/reliefScale/seed) to identical bytes
// must keep the SAME ETag across redeploys, and a cold client fetching a spawn-area tile should never
// re-download it once cached. Unlike GLB/VRM there's no on-the-fly transform step (the file on disk IS
// the artifact bake-heightfield.mjs already produced), so this reuses contentHashETag directly instead
// of GLBTransformer's separate transformed-bytes hash cache.
const CONTENT_HASHED_EXTENSIONS = new Set(['.hf'])

// Extensions worth serving Range/206 for -- large downloadable binaries where a dropped connection
// resuming from a byte offset beats re-downloading from zero. Text/JS assets are small and revalidated
// per-request anyway, so Range support for them buys nothing and adds surface area. .ktx2 added for the
// progressive-mip-streaming client (client/core/ProgressiveKTX2.js): a KTX2 container's level index
// (real per-mip byte offsets, parsed client-side) lets a range-request fetch just the lowest mip first,
// so this extension MUST be rangeable for that pipeline to work at all -- a whole-file-only KTX2 fetch
// would defeat the entire point of progressive streaming.
const RANGE_EXTENSIONS = new Set(['.glb', '.vrm', '.gltf', '.wasm', '.ktx2'])

// Extensions that get a content-hash ETag (contentHashETag) on the generic static path below in
// addition to the node_modules/.hf/JS/HTML cases: .wasm (jolt/basis, previously served with an
// `immutable` Cache-Control and NO validator -- the exact "immutable without an ETag" pattern the
// .glb.prog/ route comment below documents as a live-witnessed stale-fix trap), images and .ktx2
// (previously no ETag and no Cache-Control at all, so every browser applied its own heuristic
// freshness), and .json (world/manifest/shader-manifest documents).
const HASH_ETAG_EXTENSIONS = new Set(['.wasm', '.png', '.jpg', '.webp', '.ktx2', '.json', '.svg'])
// Explicit short-lived freshness for asset kinds that used to ship with no Cache-Control: images/.ktx2
// change only on a re-export (5 min of no-revalidate is a cheap win for a reload), .json documents
// (singleplayer-world.json, manifest.json) get 1 min, and a per-map *.shadermanifest.json is a
// recorded artifact the client already fetches with cache:'no-cache' -- honor that server-side too.
const IMAGE_CACHE_CONTROL = 'public, max-age=300'
const JSON_CACHE_CONTROL = 'public, max-age=60'
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.webp', '.ktx2', '.svg', '.ico'])

// 304 header set: ETag always, Cache-Control only when the 200 would have carried one -- Node's
// writeHead throws on an undefined header value (live-witnessed as "[static] handler error: Invalid
// value "undefined" for header "Cache-Control"" the moment an ETag'd extension had no Cache-Control).
function _notModifiedHeaders(headers) {
  const h = { 'ETag': headers['ETag'] }
  if (headers['Cache-Control']) h['Cache-Control'] = headers['Cache-Control']
  return h
}

// How many of the manifest's highest-priority (lowest-score, most urgent) entries get a real HTTP
// 103 Early Hints Link/preload pairing on the HTML entry response -- see the Early Hints wiring
// below. Bounded rather than "every entry" for two real reasons: (1) a browser that actually opens
// every hinted connection eagerly can itself contend with the FIRST real request (the JS bundle) for
// the same connection-count budget the browser enforces per origin, working against the exact "get
// the important thing first" goal this exists to serve; (2) a large map's manifest can run into the
// hundreds of KTX2 sub-resource entries, and a multi-KB Link header on every single HTML response
// would itself become a real bytes-on-the-wire cost paid before any hint work even starts.
const EARLY_HINTS_MAX = 12

// buildEarlyHintsLinks(manifest) -> ARRAY of individual Link header value strings (one per hinted
// entry: `<url>; rel=preload; as=X`), or null if there is nothing to hint (no worldDef, empty
// manifest). Node's real res.writeEarlyHints({link}) contract requires `link` to be a string OR an
// array of individual link-value strings -- NOT one comma-joined string, which throws
// ERR_INVALID_ARG_VALUE ("must be an array or string of format ...") live-witnessed against a real
// running server before this was corrected; see the caller for the exact real error text.
// `as` follows the real fetch-destination the browser preload cache keys on: 'fetch' for both
// model/textureMip kinds since both are consumed via a plain fetch()/Range fetch
// (client/core/ProgressiveKTX2.js, GLTFLoader) rather than an <img>/<video> element -- a mismatched
// `as` value makes Chrome/Firefox DISCARD the preloaded response and re-fetch, silently turning the
// hint into wasted bandwidth, so this must match the real consumer's request mode exactly.
function buildEarlyHintsLinks(manifest) {
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) return null
  const top = manifest.entries.slice(0, EARLY_HINTS_MAX)
  return top.map(e => `<${e.url}>; rel=preload; as=fetch; crossorigin`)
}

// HTTP/3 (QUIC) transport advertisement -- see AGENTS.md streaming-http3-quic-transport-infra.
// Node core (node:http/node:http2) has no HTTP/3 server, and @fails-components/webtransport's
// Http3Server (already a dependency here, used by src/transport/WebTransportServer.js for the
// game-networking transport) is explicitly a WebTransport-session-only listener, not a general
// request/response HTTP/3 server -- confirmed against the upstream project's own docs: "there is
// no intention from the author to implement" plain HTTP/3 support. So this process can never
// itself terminate HTTP/3; real termination is a reverse-proxy concern (see deploy/Caddyfile,
// which auto-negotiates h3 via Alt-Svc in front of this same plain-HTTP backend). What THIS
// process CAN own is the advertisement half of the protocol: RFC 7838 Alt-Svc tells an
// HTTP/1.1-or-2 client "an HTTP/3 endpoint for this origin exists at this authority" so the
// browser opens a QUIC connection on the NEXT request instead of never learning h3 is available.
// Off (no header, cheap no-op) unless HTTP3_ALT_SVC is explicitly configured by whatever deploys
// the reverse proxy in front of this server -- this process has no way to know an external proxy
// exists otherwise, and a false Alt-Svc advertisement (pointing at a port nothing is listening on)
// actively degrades a client's connection-reuse behavior, so silence is the only safe default.
// Accepts either a bare port ("443", expanded to the standard `h3=":<port>"; ma=86400` form) or a
// full literal Alt-Svc value (must already contain an 'h3'/'h3-' token to be treated as literal;
// anything else falls back to the port-expansion attempt so a malformed value fails loud via the
// warning below rather than silently shipping a broken header).
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

// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy: the real, concrete precondition
// `globalThis.SharedArrayBuffer` needs to be non-undefined in ANY browser context (a hard platform
// security requirement, not a config nicety -- see AGENTS.md physics-worker-isolation-sharedarraybuffer-multithread
// probe / physics-coop-coep-headers-sharedarraybuffer-enable). Sent on EVERY response from this
// handler (not just the HTML entry point), same discipline as ALT_SVC_VALUE above -- `crossOriginIsolated`
// is a document-level flag the browser computes from the TOP-LEVEL document's own response headers, so
// only the HTML entry response strictly needs it, but a plain document fetch and a same-origin JS/asset
// fetch both go through this one handler and sending it unconditionally costs nothing (COOP/COEP are
// pure response-header opt-ins, inert on a non-navigation request) versus threading an ext/url check
// through every return path below. `require-corp` (not `credentialless`) was chosen after auditing every
// real cross-origin subresource this app loads (client/index.html + client/landing/index.html's unpkg.com
// anentrypoint-design CSS/JS): unpkg sends `Cross-Origin-Resource-Policy: cross-origin` on both (confirmed
// via a real `curl -I` against the live CDN), which satisfies `require-corp` outright -- `credentialless`
// exists for cross-origin resources that DON'T opt in via CORP/CORS, which isn't this app's situation, and
// `require-corp` is the stricter/more broadly effective of the two so it's preferred whenever every
// subresource already qualifies. apps/maps GLB fetches and every other asset this server serves are
// same-origin (fetched from this same StaticHandler), so they need no CORP header of their own at all --
// COEP only gates CROSS-origin subresource loads.
const COOP_VALUE = 'same-origin'
const COEP_VALUE = 'require-corp'

export function createStaticHandler(dirs, opts = {}) {
  const getWorldInfo = typeof opts.getWorldInfo === 'function' ? opts.getWorldInfo : null
  return async (req, res) => {
    // Advertised on every response from this handler (not just the HTML entry point) so a client
    // that lands on any asset URL first -- a deep link, a direct GLB fetch, a warm cache hitting
    // the manifest -- still learns HTTP/3 is available for subsequent requests on this origin.
    if (ALT_SVC_VALUE) res.setHeader('Alt-Svc', ALT_SVC_VALUE)
    res.setHeader('Cross-Origin-Opener-Policy', COOP_VALUE)
    res.setHeader('Cross-Origin-Embedder-Policy', COEP_VALUE)
    const url = req.url.split('?')[0]
    // Per-map fetch manifest -- bake-time-derived, priority-ordered (same scoreRequest() formula the
    // live client scheduler uses, see FetchManifest.js's own top comment) list of every model/texture-
    // mip URL the current world's entities reference, so a client can open every range/whole-file
    // request for the map up front instead of discovering each dependency serially. Served plain JSON,
    // never cached client-side beyond revalidation (a world/asset can change between requests; this is
    // a hint document, not an immutable asset, so an aggressive Cache-Control would risk a client
    // acting on a stale priority order after a bake/world change).
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
    // Browsers probe /favicon.ico directly regardless of the <link rel="icon"> in index.html;
    // redirect to the real SVG favicon (client/favicon.svg, mounted at '/' below) instead of the
    // old 204-empty-response stub, so every favicon-fetch path resolves to a real icon.
    if (url === '/favicon.ico') {
      res.writeHead(302, { Location: '/favicon.svg' })
      res.end()
      return
    }
    // Which checkout/process is answering this port -- kills the stale-server-serves-wrong-checkout trap.
    if (url === '/__identity') {
      const body = JSON.stringify(getServerIdentity(), null, 2)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    // progressive-LOD virtual route: <source>.glb.prog/model.progressive.glb and <source>.glb.prog/lods/<file> map to the on-demand baked output; 404s (client falls back to plain GLB) while bake is running
    const progIdx = url.indexOf('.glb.prog/')
    if (progIdx >= 0) {
      const sourceUrl = url.slice(0, progIdx) + '.glb'
      const bakedRel = url.slice(progIdx + '.glb.prog/'.length)
      // reject `..` traversal up front; resolveBakedFile also containment-checks the resolved path
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
          // routed through the same getCached variant-cache the rest of this file uses, instead of
          // a bespoke readFileSync+compress-per-request path -- warm requests for the same baked LOD
          // (a popular progressive model refetched by many clients) hit the in-memory/disk-sibling
          // cache exactly like any other static asset.
          const { content: body, encoding: usedEncoding, mtime } = await getCached(bakedFp, bExt, encoding)
          // Content-hash ETag (of the actual served bytes), not a bare mtime/immutable contract: the
          // baked file at this SAME URL path (<source>.glb.prog/model.progressive.glb) legitimately
          // changes in place whenever the source GLB or the bake pipeline itself changes (a re-run of
          // packages/streaming-gltf/tools/bake-cluster.mjs after fixing a real defect, e.g. a degenerate-
          // triangle threshold) -- 'immutable' told every browser this URL's bytes would NEVER change for
          // 24h, so a client who had already visited once kept serving the STALE pre-fix geometry from
          // its own HTTP cache regardless of how many times the server regenerated the cache directory,
          // live-witnessed as a real fix appearing to "not take effect" in the browser even after
          // confirming (via direct fetch) that the server itself was serving corrected bytes. A real
          // conditional-GET (ETag + If-None-Match) lets an already-cached client discover a genuine
          // content change on its very next request instead of trusting a blanket 24h promise.
          const contentHash = contentHashETag(bakedFp, body, mtime)
          const etag = `"${contentHash}"`
          // no-cache, must-revalidate (not immutable/max-age): this URL is unfingerprinted -- the same
          // path legitimately serves different bytes across a re-bake -- so every load must round-trip
          // an If-None-Match check, same discipline as this file's other unfingerprinted-source route
          // above ('source is unbundled/unfingerprinted, a stale cache would silently serve an old build').
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
    // progressive-KTX2 virtual route: <source>.glb.ktx2/<imageIndex>.ktx2 maps to a standalone,
    // independently range-requestable KTX2 file extracted from the GLB-embedded KTX2 image at that
    // index (KTX2Extract.js -- GLBTransformer/GLBKtx2 bakes KTX2 textures INTO the GLB binary chunk,
    // which has no per-texture URL a client could Range-request against; this route gives each baked
    // texture a real standalone byte-addressable resource so client/core/ProgressiveKTX2.js can fetch
    // just the low-res mip level first). 404s (client falls back to waiting for the whole GLB's normal
    // KTX2Loader parse) while extraction is still running or the image index doesn't exist/isn't KTX2.
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
          // KTX2 is already-compressed binary (basis/ETC1S or UASTC transcode data) -- gzip/brotli buys
          // nothing and would defeat Range serving (serveRangeable requires the identity encoding, same
          // reasoning as the GZIP_EXTENSIONS exclusion of .png/.webp above), so this path never negotiates
          // an encoding, matching how PNG/WEBP are already excluded from GZIP_EXTENSIONS.
          const { content: body, mtime } = await getCached(ktx2Fp, '.ktx2', null)
          // Content-hash ETag + no-cache/must-revalidate, not immutable/max-age: this URL is
          // unfingerprinted -- the same path legitimately serves different bytes across a re-bake
          // (GLBTransformer.js/KTX2Extract.js code change, or a re-extraction after the source GLB
          // changes) -- same discipline as the sibling .glb.prog/ route above, whose own 'immutable'
          // header was the live-witnessed root cause of a fix appearing to "not take effect" in an
          // already-visited browser regardless of how many times the server re-baked.
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
      // a request-supplied path must resolve inside the mounted dir or a `..`-laden URL reads arbitrary server files
      const baseResolved = resolve(dir)
      const fpResolved = resolve(fp)
      if (fpResolved !== baseResolved && !fpResolved.startsWith(baseResolved + sep)) continue
      if (existsSync(fp) && statSync(fp).isFile()) {
        // lexical containment isn't enough: a symlink inside the mount can point outside it, so realpath-recheck before reading.
        // exception: a symlink under node_modules is a legitimate linked package (file:/workspace/pnpm dep) whose real files live outside the mount by design -- rejecting it would 404 every file:-linked dep and abort the ES-module graph
        const isNodeModulesLink = fpResolved.includes(sep + 'node_modules' + sep)
        let realFp
        try { realFp = realpathSync(fp) } catch { continue }
        if (!isNodeModulesLink && realFp !== baseResolved && !realFp.startsWith(baseResolved + sep)) continue
        const ext = extname(fp)
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' }
        const isRevalidatable = ext === '.js' || ext === '.mjs' || ext === '.html' || ext === '.css'

        // HTTP 103 Early Hints, paired with the same bake-time fetch manifest '/__fetch-manifest.json'
        // serves -- see FetchManifest.js's own top comment for why this reuses scoreRequest() rather
        // than a separate priority notion. Fired for the HTML entry document ONLY (the very first
        // response of a page load, before the client has even parsed a single <script> tag, which is
        // the whole point of Early Hints: let the browser open the model/texture connections while the
        // server is still building/serving the main response body it's hinting about -- pairing it
        // with any other file type would fire long after the client already knows its own dependency
        // graph, buying nothing). Best-effort: res.writeEarlyHints is a real Node core API (18+, HTTP/1.1
        // interim-response support landed then; also valid on HTTP/2), but (a) it may be undefined on
        // an older Node the deployed environment happens to run, and (b) some proxies/CDNs in front of
        // this server may not forward interim 1xx responses at all -- either way this must never block
        // or fail the real 200 response that follows, so both are guarded and swallowed.
        // Skip Early Hints entirely for a request explicitly marked as coming through the edge
        // Worker's option-(b) static-asset reverse-proxy (see edge/cf-do/spoint-do.js) -- live-probed
        // this session against a real `wrangler dev` workerd instance: workerd's own `fetch()` client
        // does NOT correctly pass an interim 103 response through to its caller the way a browser or
        // Node's fetch does, it instead surfaces the 103 itself AS the final Response (status:103,
        // never reaching the real 200 body at all) -- a real, reproducible, edge-runtime-specific
        // client bug, not a Node/StaticHandler defect and not covered by the existing "some proxies
        // may not forward interim responses" comment above (that assumed silent drop, not
        // response-hijack). Rather than let every option-(b) deployment silently break page loads,
        // the Worker's own reverse-proxy fetch sets this header so the origin degrades gracefully
        // (matching the pre-existing "must never block or fail the real 200" contract) instead of
        // emitting a 103 no edge-fetch client here can safely consume.
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
            // Early Hints are a pure optimization -- a failure here (manifest build error, a proxy that
            // rejects/mangles a 103, etc) must degrade to "no hints sent", never to a broken page load.
            console.warn('[early-hints] skipped:', e?.message || e)
          }
        }

        if (isRevalidatable) {
          // must-revalidate not immutable: source is unbundled/unfingerprinted, a stale cache would silently serve an old build
          headers['Cache-Control'] = 'no-cache, must-revalidate'
        } else if (ext === '.glb' || ext === '.vrm' || ext === '.gltf' || ext === '.wasm' || CONTENT_HASHED_EXTENSIONS.has(ext)) {
          // .hf: baked heightfield tiles only change when scripts/bake-heightfield.mjs re-bakes them
          // (terrain param change), never per-request -- immutable + the content-hash ETag below is
          // exactly the CDN-friendly caching contract this artifact needs. See AGENTS.md
          // cdn-hosted-baked-heightfield-tiles-static.
          headers['Cache-Control'] = 'public, max-age=86400, immutable'
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          headers['Cache-Control'] = IMAGE_CACHE_CONTROL
        } else if (ext === '.json') {
          headers['Cache-Control'] = fp.endsWith('.shadermanifest.json') ? 'no-cache, must-revalidate' : JSON_CACHE_CONTROL
        }

        // Range/206 is only meaningful against the identity encoding (see serveRangeable): a client
        // that sends a Range header for a rangeable asset (progressive KTX2 mips, a resumed GLB/wasm
        // download) must not be handed a compressed whole-body 200 just because .wasm/.glb are now in
        // GZIP_EXTENSIONS -- skip negotiation for that request so the 206 path below stays reachable.
        const wantsRange = !!req.headers['range'] && RANGE_EXTENSIONS.has(ext)

        if (ext === '.glb' || ext === '.vrm') {
          const srcMtime = statSync(fp).mtimeMs
          // Awaits an in-flight bake (fresh upload, editor-replaced asset, or the boot-time prewarm's
          // own in-flight promise for this exact file) instead of racing past it -- see
          // static-transform-cold-boot-request-race. A request landing mid-bake now gets the correct,
          // final transformed bytes instead of falling through to the untransformed raw file below
          // with an `immutable` 24h cache header.
          const transformed = await getTransformedAsync(fp)
          if (transformed) {
            const encoding = wantsRange ? null : negotiateEncoding(req)
            // Content-hash ETag (of the TRANSFORMED bytes), not srcMtime -- see
            // AGENTS.md content-hash-asset-cache-revalidation / GLBTransformer.js's hashFor. A
            // redeploy/fresh-checkout that re-bakes the identical source to identical optimized
            // bytes keeps the SAME ETag, so a client's already-cached copy (browser HTTP cache or
            // client/ModelCache.js's IndexedDB store, both revalidate via If-None-Match) genuinely
            // 304s instead of re-downloading solely because mtime moved. Falls back to the old
            // mtime-based tag only in the (should-be-unreachable, since transformed is truthy here)
            // case the hash lookup races a cache eviction -- never serves a missing/undefined ETag.
            // Computed BEFORE the compressed variant so a 304 never pays compression, and so the
            // same hash keys the disk-persisted .br/.gz sibling next to the .glb-cache output
            // (StaticCache.getTransformedCached's `sibling` -- survives a process restart instead
            // of re-brotli-ing every transformed asset on its first request of every boot).
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
          // node_modules (and .hf baked heightfield tiles, always): content-hash so a redeploy/re-bake
          // that reproduces byte-identical output keeps the same ETag (mtime always changes on a fresh
          // install/checkout/re-bake even when bytes didn't). Everything else keeps the cheaper
          // mtime-based ETag -- those files are the app's own source, edited in place, where mtime
          // tracking a real edit is exactly the semantics wanted. HASH_ETAG_EXTENSIONS (.wasm/images/
          // .ktx2/.json) are binary/generated artifacts re-materialized on install/export, so they take
          // the content-hash form for the same redeploy-stable reason as node_modules.
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
