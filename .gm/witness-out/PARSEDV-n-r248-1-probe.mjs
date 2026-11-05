import * as T from '/workspace/spoint/src/shared/terrainConfig.js'
const p = T.parseTerrainConfig({ seed: 7, radius: 1000, carves: [{ center: [1, 2], radius: 3, falloff: 4 }] })
const raw = { seed: 7, radius: 1000, minimapExtent: 50, minimapRes: 64 }
const parsedAccessors = {
  isParsed: T.isParsedTerrainConfig(p.config),
  extent: T.minimapExtentOf(p.config), res: T.minimapResOf(p.config),
  hashVersion: T.terrainHashVersionOf(p.config), carves: T.terrainCarvesOf(p.config).length,
}
const rawAccessors = { extent: T.minimapExtentOf(raw), res: T.minimapResOf(raw), hashVersion: T.terrainHashVersionOf(raw) }
const bad = T.parseTerrainConfig({ seed: 7, radius: -1 })
console.log(JSON.stringify({ parsedAccessors, rawAccessors, badParse: { ok: bad.ok, path: bad.path, reason: bad.reason } }))
