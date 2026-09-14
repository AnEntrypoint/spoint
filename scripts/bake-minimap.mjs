import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PNG_BIT_DEPTH = 8
const PNG_COLOR_TYPE_RGB = 2
const PNG_FILTER_NONE = 0
const DEEP_OCEAN_BELOW_M = -200
const BEACH_TOP_M = 8
const SNOWCAP_ABOVE_M = 2200
const ROCK_SNOW_BLEND_ABOVE_M = 1300
const UPLAND_ABOVE_M = 500
const MIN_GRID_RES = 2

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

function biomeColor(height, temp, humidity, seaLevel) {
  const h = height - seaLevel
  if (h < DEEP_OCEAN_BELOW_M) return [18, 42, 92]
  if (h < 0) return [42, 92, 158]
  if (h < BEACH_TOP_M) return [214, 199, 152]
  if (h > SNOWCAP_ABOVE_M) return [235, 238, 242]
  if (h > ROCK_SNOW_BLEND_ABOVE_M) {
    const t = Math.max(0, Math.min(1, (h - ROCK_SNOW_BLEND_ABOVE_M) / 900))
    return lerp3([120, 118, 108], [235, 238, 242], t)
  }
  if (h > UPLAND_ABOVE_M) return lerp3([96, 128, 74], [120, 118, 108], Math.max(0, Math.min(1, (h - UPLAND_ABOVE_M) / 800)))
  const dry = [176, 164, 108]
  const forest = [58, 108, 58]
  const grass = [104, 150, 76]
  let base = lerp3(dry, grass, Math.max(0, Math.min(1, humidity)))
  base = lerp3(base, forest, Math.max(0, Math.min(1, humidity - 0.5)) * 2 * Math.max(0, Math.min(1, (temp - 0.15) / 0.7)))
  return base
}
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }

async function loadTerrainConfigFromWorld(worldName) {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'apps', 'world', `${worldName}.js`)).href)
  const def = mod.default || mod
  return def.terrain || (def.entities || []).find(e => e.app === 'terrain')?.config || null
}

export async function bakeMinimap(opts) {
  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const { createPlanetFrame, waterlineLocalY } = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'terrain', 'PlanetFrame.js')).href)
  const { createAnchorField } = await import('mapspinner/anchor-field')

  const radius = opts.radius
  const seed = opts.seed | 0
  const reliefScale = opts.reliefScale
  const anchorDir = opts.anchorDir || [0, 1, 0]
  const extent = Number.isFinite(opts.extent) && opts.extent > 0 ? opts.extent : 8192
  const N = Number.isFinite(opts.res) && opts.res >= MIN_GRID_RES ? Math.round(opts.res) : MIN_GRID_RES
  const center = opts.center || [0, 0]

  const sampler = await createHeightSampler({ radius, seed, reliefScale })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: 0, reliefScale })
  const anchorField = sampler.anchorField || createAnchorField({ seed })

  const half = extent / 2, step = extent / (N - 1)
  const heights = new Float32Array(N * N)
  const rgb = Buffer.alloc(N * N * 3)
  let min = Infinity, max = -Infinity

  for (let iz = 0; iz < N; iz++) {
    const z = center[1] - half + iz * step
    for (let ix = 0; ix < N; ix++) {
      const x = center[0] - half + ix * step
      const h = frame.groundHeightLocal(x, z)
      const idx = iz * N + ix
      heights[idx] = h
      if (h < min) min = h
      if (h > max) max = h
      const dir = frame.localToDir(x, z)
      const climate = anchorField.sampleDir ? anchorField.sampleDir(dir) : { temp: 0.5, humidity: 0.5 }
      const [r, g, b] = biomeColor(h, climate.temp || 0, climate.humidity || 0, waterlineLocalY(frame, x, z))
      const o = idx * 3
      rgb[o] = r | 0; rgb[o + 1] = g | 0; rgb[o + 2] = b | 0
    }
  }

  const png = encodePNGRGB(N, N, rgb)
  const header = {
    seed, radius, anchorDir, reliefScale, extent, N, center,
    minHeight: +min.toFixed(2), maxHeight: +max.toFixed(2),
    generatedAt: Date.now(),
  }
  return { png, heights, header, min, max }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let cfg
  if (args.world) {
    cfg = await loadTerrainConfigFromWorld(String(args.world))
    if (!cfg) { console.error(`[minimap] world "${args.world}" has no terrain config`); process.exit(1) }
  } else {
    cfg = {
      seed: Number(args.seed || 0),
      radius: Number(args.radius || 63600),
      reliefScale: args.reliefScale != null ? Number(args.reliefScale) : undefined,
      anchorDir: args.anchorDir ? args.anchorDir.split(',').map(Number) : [0, 1, 0],
    }
  }
  const extent = Number(args.extent || cfg.minimapExtent || 8192)
  const res = Number(args.res || 512)
  const center = args.center ? args.center.split(',').map(Number) : (cfg.center || [0, 0])
  const outPng = args.out ? path.resolve(REPO_ROOT, args.out) : path.join(REPO_ROOT, 'apps', 'world', `${args.world || 'minimap'}.minimap.png`)
  const outJson = outPng.replace(/\.png$/i, '.json')

  const t0 = Date.now()
  const { png, header } = await bakeMinimap({
    seed: cfg.seed, radius: cfg.radius, reliefScale: cfg.reliefScale, anchorDir: cfg.anchorDir,
    extent, res, center,
  })
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
