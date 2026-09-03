// bake-minimap.mjs -- bake a top-down COLOR+HEIGHT minimap for a terrain seed at world-build time.
//
// Pure Node, THREE/GL-free: reuses the same CPU height path TerrainPhysics.js already uses for the
// server collider (mapspinner/height-cpu's createHeightSampler, transpiled from terrain.glsl -- see
// AGENTS.md project/cpu-gpu-height-parity-integer-hash) plus PlanetFrame's local (x,z) <-> planet-dir
// mapping (src/terrain/PlanetFrame.js), so a minimap texel's height matches the real server-side
// ground height at that local (x,z), not a re-derived approximation. Color is a biome-style ramp
// (sea/beach/grass/rock/snow bands keyed on height + climate temp/humidity/seaBias from the anchor
// field's sampleDir -- ClimateCache.js's same {temp,humidity,erosion,seaBias} shape) -- not a pixel
// match to terrain.glsl's GPU shading (that needs the GPU-eval harness bake-heightfield.mjs uses;
// out of scope for a minimap whose job is orientation, not exact color fidelity).
//
// PNG output uses a self-contained no-dependency RGB encoder (PNG color type 2, zlib deflate for
// IDAT) -- the same proven no-dep pattern as packages/mapspinner/scripts/lab.mjs's encodePNGGray,
// extended to 3 channels. No sharp/canvas dependency (scripts/lib/heatmap-image.mjs's sharp-based
// approach is best-effort/optional and unsuitable as the primary minimap bake path).
//
// Usage:
//   node scripts/bake-minimap.mjs --seed 1337 --radius 63600 --anchorDir -0.641,0.2558,0.7237 \
//     --reliefScale 0.001 --extent 8192 --res 512 --out apps/world/tps-game.minimap.png
//   node scripts/bake-minimap.mjs --world tps-game    (reads apps/world/<name>.js terrain config directly)
//
// Artifact pair: <out>.png (RGB, N x N) + <out-without-ext>.json (small header: seed, radius, extent,
// N, anchorDir, reliefScale, center, minHeight, maxHeight -- enough for a consumer to map a world (x,z)
// to a minimap pixel and decode the height range the color ramp was built against).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

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

// ---------------------------------------------------------------- PNG (no deps, node zlib), RGB variant
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
// 8-bit RGB PNG (color type 2) from a width*height*3 Uint8Array
export function encodePNGRGB(width, height, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit, RGB truecolor
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1)
    raw[rowOff] = 0 // filter: none
    rgb.copy ? rgb.copy(raw, rowOff + 1, y * stride, (y + 1) * stride) : raw.set(rgb.subarray(y * stride, (y + 1) * stride), rowOff + 1)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------- biome color ramp
// Height + climate -> RGB. Mirrors the coarse band structure terrain.glsl's FS shading uses
// (deep water / shallow water / beach / grass-lowland / rock-highland / snow-peak) without
// attempting pixel parity with the real GPU shader (see file header).
function biomeColor(height, temp, humidity, seaLevel) {
  const h = height - seaLevel
  if (h < -200) return [18, 42, 92]      // deep ocean
  if (h < 0) return [42, 92, 158]        // shallow water / coastal shelf
  if (h < 8) return [214, 199, 152]      // beach / sand
  // land: blend by temp/humidity/elevation into grass/forest/rock/snow
  if (h > 2200) return [235, 238, 242]   // snowcap
  if (h > 1300) {
    const t = Math.max(0, Math.min(1, (h - 1300) / 900))
    return lerp3([120, 118, 108], [235, 238, 242], t) // rock -> snow transition
  }
  if (h > 500) return lerp3([96, 128, 74], [120, 118, 108], Math.max(0, Math.min(1, (h - 500) / 800))) // upland rock/scrub
  // lowland: dry (humidity low) -> arid tan, wet -> green forest, cold+wet stays but tints
  const dry = [176, 164, 108]
  const forest = [58, 108, 58]
  const grass = [104, 150, 76]
  let base = lerp3(dry, grass, Math.max(0, Math.min(1, humidity)))
  base = lerp3(base, forest, Math.max(0, Math.min(1, humidity - 0.5)) * 2 * Math.max(0, Math.min(1, (temp - 0.15) / 0.7)))
  return base
}
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }

// ---------------------------------------------------------------- bake
async function loadTerrainConfigFromWorld(worldName) {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'apps', 'world', `${worldName}.js`)).href)
  const def = mod.default || mod
  return def.terrain || (def.entities || []).find(e => e.app === 'terrain')?.config || null
}

export async function bakeMinimap(opts) {
  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const { createPlanetFrame } = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'terrain', 'PlanetFrame.js')).href)
  const { createAnchorField } = await import('mapspinner/anchor-field')

  const radius = opts.radius
  const seed = opts.seed | 0
  const reliefScale = opts.reliefScale
  const anchorDir = opts.anchorDir || [0, 1, 0]
  const extent = Number.isFinite(opts.extent) && opts.extent > 0 ? opts.extent : 8192
  // N=1 makes step=extent/(N-1)=Infinity (every sampled coord degenerates to NaN, min/max stay at
  // their +-Infinity sentinels forever -- JSON.stringify then silently drops them to null). N=2 is
  // the smallest grid that still has a real, finite step; clamp rather than produce a corrupt bake.
  const N = Number.isFinite(opts.res) && opts.res >= 2 ? Math.round(opts.res) : 2
  const center = opts.center || [0, 0]

  const sampler = await createHeightSampler({ radius, seed, reliefScale })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: 0, reliefScale })
  const anchorField = sampler.anchorField || createAnchorField({ seed })

  const half = extent / 2, step = extent / (N - 1)
  const heights = new Float32Array(N * N)
  const rgb = Buffer.alloc(N * N * 3)
  let min = Infinity, max = -Infinity

  // sea-level reference: local height at the anchor point itself (x=0,z=0 is always h=0 by
  // construction of groundHeightLocal's drop term) -- 0 is the correct sea-level datum in LOCAL space.
  const seaLevel = 0

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
      const [r, g, b] = biomeColor(h, climate.temp || 0, climate.humidity || 0, seaLevel)
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
