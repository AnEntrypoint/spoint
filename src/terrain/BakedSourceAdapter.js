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
      let raw
      try { raw = fs.readFileSync(String(url).replace(/^\//, '')) }
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
