import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { resolveTerrainConfig, parseTerrainConfig, minimapDescriptor, minimapExtentOf, minimapResOf, terrainHashVersionOf, terrainCarvesOf, parseTerrainHashOverride, withTerrainHashVersion } from '../src/shared/terrainConfig.js'
import { sampleMinimapCell, shadeHeightGrid } from '../src/shared/MinimapBiome.js'
import { MINIMAP_BAKE_CODE_VERSION } from '../src/static/BakeCodeVersion.js'
import { expandWorldPresets } from '../src/shared/worldPresets.js'
import { findWorldFile, worldRoots } from '../src/sdk/WorldLocator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PNG_BIT_DEPTH = 8
const PNG_COLOR_TYPE_RGB = 2
const PNG_FILTER_NONE = 0
const MIN_GRID_RES = 2

function finiteArray(v, n) {
  return Array.isArray(v) && v.length === n && v.every(Number.isFinite)
}

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const k = t.slice(2); const n = argv[i + 1]
      if (n === undefined || n.startsWith('--')) a[k] = true
      else { a[k] = n; i++ }
    } else a._.push(t)
  }
  return a
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, 'ascii')
  const body = Buffer.concat([tb, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
export function encodePNGRGB(width, height, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = PNG_BIT_DEPTH; ihdr[9] = PNG_COLOR_TYPE_RGB; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1)
    raw[rowOff] = PNG_FILTER_NONE
    rgb.copy ? rgb.copy(raw, rowOff + 1, y * stride, (y + 1) * stride) : raw.set(rgb.subarray(y * stride, (y + 1) * stride), rowOff + 1)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

async function loadTerrainConfigFromWorld(worldName, hashOverride) {
  const worldFile = findWorldFile(worldName, worldRoots(REPO_ROOT)) || path.join(REPO_ROOT, 'apps', 'world', `${worldName}.js`)
  if (!fs.existsSync(worldFile)) return { ok: false, field: 'world', reason: `no world file for "${worldName}"` }
  const mod = await import(pathToFileURL(worldFile).href)
  const worldDef = expandWorldPresets(mod.default || mod)
  const tcfg = resolveTerrainConfig(hashOverride == null ? worldDef : withTerrainHashVersion(worldDef, hashOverride))
  if (!tcfg) return { ok: false, field: 'terrain', reason: `world "${worldName}" declares no terrain config` }
  const parsed = parseTerrainConfig(tcfg)
  if (!parsed.ok) return { ok: false, field: `terrain.${parsed.path}`, reason: parsed.reason }
  if (!minimapDescriptor(worldName, parsed.config)) return { ok: false, field: 'terrain', reason: `world "${worldName}" terrain is disabled or its seed is not a finite number` }
  return { ok: true, config: parsed.config }
}

export function parseMinimapBakeOpts(opts) {
  const reject = (field, reason) => ({ ok: false, field, reason })
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return reject('opts', 'must be a plain object')
  if (!Number.isFinite(opts.seed)) return reject('seed', 'must be a finite number')
  if (!(Number.isFinite(opts.radius) && opts.radius > 0)) return reject('radius', 'must be a positive finite number')
  if (opts.reliefScale != null && !Number.isFinite(opts.reliefScale)) return reject('reliefScale', 'must be a finite number')
  const anchorDir = opts.anchorDir ?? [0, 1, 0]
  if (!finiteArray(anchorDir, 3)) return reject('anchorDir', 'must be [x, y, z] of finite numbers')
  const center = opts.center ?? [0, 0]
  if (!finiteArray(center, 2)) return reject('center', 'must be [x, z] of finite numbers')
  const carves = opts.carves ?? []
  if (!Array.isArray(carves) || !carves.every(c => finiteArray(c?.dir, 3) && Number.isFinite(c?.innerM) && Number.isFinite(c?.outerM))) return reject('carves', 'must be an array of { dir: [x, y, z], innerM, outerM }')
  const extent = minimapExtentOf({ radius: opts.radius, minimapExtent: opts.extent })
  if (!(Number.isFinite(extent) && extent > 0)) return reject('extent', 'must be a positive finite number')
  const res = minimapResOf({ minimapRes: opts.res })
  if (!(Number.isFinite(res) && res >= MIN_GRID_RES)) return reject('res', `must be a finite number >= ${MIN_GRID_RES}`)
  let hashVersion
  try { hashVersion = terrainHashVersionOf(opts) } catch (e) { return reject('hashVersion', e.message) }
  return { ok: true, bake: { seed: opts.seed | 0, radius: opts.radius, reliefScale: opts.reliefScale, anchorDir, extent, res: Math.round(res), center, hashVersion, carves } }
}

export async function bakeMinimap(opts) {
  const parsed = parseMinimapBakeOpts(opts)
  if (!parsed.ok) throw new TypeError(`[minimap] ${parsed.field}: ${parsed.reason}`)
  const { radius, seed, reliefScale, anchorDir, extent, center, hashVersion, carves, res: N } = parsed.bake

  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const { createPlanetFrame } = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'terrain', 'PlanetFrame.js')).href)
  const { createAnchorField } = await import('mapspinner/anchor-field')

  const sampler = await createHeightSampler({ radius, seed, reliefScale, hashVersion, carves })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: 0, reliefScale })
  const anchorField = sampler.anchorField || createAnchorField({ seed })

  const half = extent / 2, step = extent / N
  const heights = new Float32Array(N * N)
  const biomeRgb = new Uint8Array(N * N * 3)
  const land = new Uint8Array(N * N)
  const rgb = Buffer.alloc(N * N * 3)
  const cell = [0, 0, 0, 0, NaN]
  let min = Infinity, max = -Infinity

  for (let iz = 0; iz < N; iz++) {
    const z = center[1] - half + (iz + 0.5) * step
    let prevY = NaN, prevY2 = NaN
    for (let ix = 0; ix < N; ix++) {
      const x = center[0] - half + (ix + 0.5) * step
      const guess = Number.isFinite(prevY) && Number.isFinite(prevY2) ? prevY + (prevY - prevY2) : prevY
      const h = sampleMinimapCell(frame, anchorField, x, z, cell, guess)
      prevY2 = prevY
      prevY = cell[4]
      const idx = iz * N + ix
      heights[idx] = h
      land[idx] = cell[3]
      if (h < min) min = h
      if (h > max) max = h
      const o = idx * 3
      biomeRgb[o] = cell[0]; biomeRgb[o + 1] = cell[1]; biomeRgb[o + 2] = cell[2]
    }
  }
  shadeHeightGrid(heights, N, N, step, land, biomeRgb, rgb, 3, 3)

  const png = encodePNGRGB(N, N, rgb)
  const header = {
    seed, radius, anchorDir, reliefScale, hashVersion, carves, extent, N, center,
    minHeight: +min.toFixed(2), maxHeight: +max.toFixed(2),
    codeVersion: MINIMAP_BAKE_CODE_VERSION,
    generatedAt: Date.now(),
  }
  return { png, heights, header, min, max }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let hashOverride
  try {
    hashOverride = parseTerrainHashOverride(args.hashVersion)
  } catch (e) {
    console.error(`[minimap] hashVersion: ${e.message}`)
    process.exit(2)
  }
  let cfg
  if (args.world) {
    const loaded = await loadTerrainConfigFromWorld(String(args.world), hashOverride)
    if (!loaded.ok) { console.error(`[minimap] ${loaded.field}: ${loaded.reason}`); process.exit(1) }
    cfg = loaded.config
  } else {
    cfg = {
      seed: Number(args.seed || 0),
      radius: Number(args.radius || 63600),
      reliefScale: args.reliefScale != null ? Number(args.reliefScale) : undefined,
      anchorDir: args.anchorDir ? args.anchorDir.split(',').map(Number) : [0, 1, 0],
      hashVersion: hashOverride ?? undefined,
    }
  }
  const worldBaked = args.world ? minimapDescriptor(String(args.world), cfg) : null
  const extent = Number(args.extent || (worldBaked ? minimapExtentOf(cfg) : cfg.minimapExtent || 8192))
  const res = Number(args.res || (worldBaked ? minimapResOf(cfg) : 512))
  const center = args.center ? args.center.split(',').map(Number) : (cfg.center || [0, 0])
  const defaultOut = worldBaked ? path.join(REPO_ROOT, `${worldBaked.base}.png`) : path.join(REPO_ROOT, 'apps', 'world', 'minimap.minimap.png')
  const outPng = args.out ? path.resolve(REPO_ROOT, args.out) : defaultOut
  const outJson = outPng.replace(/\.png$/i, '.json')

  const bakeInput = parseMinimapBakeOpts({
    seed: cfg.seed, radius: cfg.radius, reliefScale: cfg.reliefScale, anchorDir: cfg.anchorDir, hashVersion: cfg.hashVersion,
    carves: terrainCarvesOf(cfg), extent, res, center,
  })
  if (!bakeInput.ok) { console.error(`[minimap] ${bakeInput.field}: ${bakeInput.reason}`); process.exit(2) }
  const t0 = Date.now()
  const { png, header } = await bakeMinimap(bakeInput.bake)
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  fs.writeFileSync(outPng, png)
  fs.writeFileSync(outJson, JSON.stringify(header))
  const ms = Date.now() - t0
  console.log(JSON.stringify({ outPng, outJson, ...header, bytes: png.length, ms }))
}

const _entryArg = process.argv[1]
if (_entryArg && (import.meta.url === `file://${_entryArg}` || import.meta.url === `file:///${_entryArg.replace(/\\/g, '/')}`)) {
  main().catch(e => { console.error('[minimap] bake failed:', e?.stack || e?.message || e); process.exit(1) })
}
