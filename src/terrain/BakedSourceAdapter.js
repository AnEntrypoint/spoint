import { bakedFieldError } from './TerrainPhysics.js'

const BAKE_CODE_VERSION_SPEC = ['..', 'static', 'BakeCodeVersion.js'].join('/')
const NODE_CODEC_SPEC = 'mapspinner/heightfield-codec'
const BROWSER_CODEC_SPEC = '/node_modules/' + 'mapspinner/src/heightfield-codec.js'

export function nodeBakedSource() {
  return {
    async readBytes(url) {
      const fs = await import('node:fs')
      const path = await import('node:path')
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
    async bakeCodeVersion() {
      return null
    },
  }
}

const _hotSwapBakedSourceAdapter = (next) => {
  nodeBakedSource = next.nodeBakedSource
  browserBakedSource = next.browserBakedSource
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapBakedSourceAdapter)
