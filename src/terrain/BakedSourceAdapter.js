// The two adapters for the port src/terrain/TerrainPhysics.js declares. A baked artifact is bytes,
// a decoder for those bytes and the height code version this tree bakes, and which platform supplies
// them is the caller's business, never the loader's: TerrainPhysics.js imports neither adapter, so
// the module that answers what the ground is still parses where neither node:fs nor fetch exists.
//
// Both adapters derive every refusal from bakedFieldError, the one factory the loader throws from,
// so "absent is a silent fallback, anything else is [baked-heightfield]" has exactly one source.
import { bakedFieldError } from './TerrainPhysics.js'

const BAKE_CODE_VERSION_SPEC = ['..', 'static', 'BakeCodeVersion.js'].join('/')
const NODE_CODEC_SPEC = 'mapspinner/heightfield-codec'
const BROWSER_CODEC_SPEC = '/node_modules/' + 'mapspinner/src/heightfield-codec.js'

export function nodeBakedSource() {
  return {
    async readBytes(url) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      // A bake url is a served path ('/worlds/x.hf', relative to the repo root) or an absolute
      // filesystem path. A rooted url that exists as itself is the filesystem path; anything else is
      // served-relative. Stripping the slash unconditionally read a POSIX absolute path as cwd-relative,
      // so an existing artifact came back ENOENT and was taken for an absent bake.
      const file = String(url)
      const filePath = path.isAbsolute(file) && fs.existsSync(file) ? file : file.replace(/^\//, '')
      let raw
      try { raw = fs.readFileSync(filePath) }
      catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null
        throw bakedFieldError(url, `cannot be read: ${e?.message || e}`, e)
      }
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    },
    async heightfieldCodec() {
      return await import(NODE_CODEC_SPEC)
    },
    async bakeCodeVersion() {
      const { HEIGHTFIELD_BAKE_CODE_VERSION } = await import(BAKE_CODE_VERSION_SPEC)
      return HEIGHTFIELD_BAKE_CODE_VERSION
    },
  }
}

export function browserBakedSource() {
  return {
    async readBytes(url) {
      let res
      try { res = await fetch(url) }
      catch (e) { throw bakedFieldError(url, `cannot be read: ${e?.message || e}`, e) }
      if (!res.ok) {
        if (res.status === 404) return null
        throw bakedFieldError(url, `cannot be read: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`)
      }
      return res.arrayBuffer()
    },
    async heightfieldCodec() {
      return await import(BROWSER_CODEC_SPEC)
    },
    // A browser has no bake sources to rehash, so it cannot stamp or verify one: it reads the
    // artifact's own stamp or warns and falls back, which is the loader's null branch.
    async bakeCodeVersion() {
      return null
    },
  }
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapBakedSourceAdapter = (next) => {
  nodeBakedSource = next.nodeBakedSource
  browserBakedSource = next.browserBakedSource
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapBakedSourceAdapter)
