import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export const SOFTWARE_ARGS = ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
export const ACCELERATED_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization']

const SOFTWARE_MARKERS = /swiftshader|llvmpipe|softwarerasterizer|basic render|mesa offscreen|subzero/i

export function angleBackendArgs(backend) {
  return ['--use-gl=angle', `--use-angle=${backend}`]
}

export async function probeGpu(page) {
  return page.evaluate(async () => {
    const markers = /swiftshader|llvmpipe|softwarerasterizer|basic render|mesa offscreen|subzero/i
    let renderer = null
    let vendor = null
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
      if (dbg) {
        renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || null
        vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || null
      }
    } catch (_) {}
    let adapter = null
    try {
      if (navigator.gpu) {
        const a = await navigator.gpu.requestAdapter()
        const info = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null))
        if (info) {
          adapter = {
            vendor: info.vendor || null,
            architecture: info.architecture || null,
            device: info.device || null,
            description: info.description || null,
          }
        }
      }
    } catch (_) {}
    let pageRenderer = null
    try {
      const ri = window.__rendererInfo
      if (ri && typeof ri.glRenderer === 'string' && ri.glRenderer) pageRenderer = ri.glRenderer
    } catch (_) {}
    const parts = [renderer, vendor, pageRenderer, adapter && adapter.vendor, adapter && adapter.description].filter(Boolean)
    const haystack = parts.join(' | ')
    return {
      accelerated: parts.length > 0 && !markers.test(haystack),
      renderer: renderer || pageRenderer,
      vendor,
      adapter,
      haystack,
    }
  })
}

export { SOFTWARE_MARKERS }

export function rasterizerOf(...parts) {
  const haystack = parts.filter(Boolean).join(' | ')
  return rasterizerClass({ haystack, accelerated: haystack.length > 0 && !SOFTWARE_MARKERS.test(haystack) })
}

export function rasterizerClass(probe) {
  if (!probe || !probe.haystack) return 'unknown'
  return probe.accelerated ? 'accelerated' : 'software'
}

export async function assertGpu(page, opts = {}) {
  const probe = await probeGpu(page)
  const rasterizer = rasterizerClass(probe)
  if (opts.requireAccelerated && rasterizer !== 'accelerated') {
    throw new Error(`gpu probe: session is ${rasterizer}, not accelerated (${probe.haystack || 'no renderer strings exposed'})`)
  }
  if (opts.expectVendor && !new RegExp(opts.expectVendor, 'i').test(probe.haystack || '')) {
    throw new Error(`gpu probe: expected vendor /${opts.expectVendor}/, got ${probe.haystack || 'no renderer strings exposed'}`)
  }
  return { ...probe, rasterizer }
}

export function gpuArgs({ accelerated = false } = {}) {
  return accelerated ? ACCELERATED_ARGS : SOFTWARE_ARGS
}

const SOFTWARE_MODES = new Set(['software', 'swiftshader', 'none'])

export function gpuModeOf(mode) {
  const raw = typeof mode === 'string' ? mode : (mode && mode.mode) || 'software'
  const software = SOFTWARE_MODES.has(raw)
  return { mode: raw, software, accelerated: !software, vendor: software || raw === 'accelerated' ? null : raw }
}

export function gpuModeFlag(name = 'gpu', dflt = 'software') {
  const modern = process.argv.find((a) => a.startsWith(`--${name}=`))
  const legacy = process.argv.find((a) => a.startsWith('--gl='))
  const value = modern ? modern.slice(name.length + 3) : legacy ? legacy.slice(5) : dflt
  return gpuModeOf(value)
}

export function gpuLaunchArgs(mode, extra = []) {
  return [...gpuArgs({ accelerated: gpuModeOf(mode).accelerated }), ...extra]
}

const ANGLE_D3D11_ARGS = ['--use-gl=angle', '--use-angle=d3d11']

const VENDOR_ADAPTER_PATTERNS = {
  nvidia: 'nvidia|geforce|quadro|rtx',
  amd: 'amd|radeon',
  intel: 'intel|arc|iris|uhd',
  igpu: 'intel|arc|iris|uhd',
}

export function vendorGpuArgs(vendor, luids = {}) {
  const base = ANGLE_D3D11_ARGS
  if (!vendor || vendor === 'accelerated' || vendor === 'software' || vendor === 'swiftshader') return base
  const luid = luids[vendor] || adapterLuidFor(VENDOR_ADAPTER_PATTERNS[vendor] || vendor)
  if (!luid) throw new Error(`gpu-probe: no DirectX adapter matches vendor "${vendor}" -- pass an explicit adapter LUID`)
  return [...base, `--use-adapter-luid=0,${luid}`]
}

export async function witnessGpu(page, mode) {
  const want = gpuModeOf(mode)
  const gpu = await assertGpu(page, { requireAccelerated: want.accelerated, expectVendor: want.vendor })
  return { ...gpu, mode: want.mode, software: want.software }
}

const DIRECTX_KEY = 'HKLM\\SOFTWARE\\Microsoft\\DirectX'

const ADAPTER_FIELDS = 'AdapterLuid|Description|LastSeen|VendorId|DeviceId'

export function directxAdapters() {
  if (process.platform !== 'win32') return []
  const out = execFileSync('reg', ['query', DIRECTX_KEY, '/s'], { encoding: 'utf8', windowsHide: true })
  const adapters = []
  let current = null
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { current = {}; continue }
    const m = new RegExp(`^\\s+(${ADAPTER_FIELDS})\\s+REG_\\w+\\s+(.*)$`).exec(line)
    if (!m || !current) continue
    const raw = m[2].trim()
    if (m[1] === 'Description') { current.description = raw; adapters.push(current) }
    else if (m[1] === 'AdapterLuid') current.luid = parseInt(raw, 16)
    else if (m[1] === 'LastSeen') current.lastSeen = parseInt(raw, 16)
    else if (m[1] === 'VendorId') current.vendorId = parseInt(raw, 16)
    else if (m[1] === 'DeviceId') current.deviceId = parseInt(raw, 16)
  }
  return adapters.filter((a) => Number.isFinite(a.luid) && a.description)
}

export function luidCandidatesFor(pattern) {
  const re = new RegExp(pattern, 'i')
  return directxAdapters()
    .filter((a) => re.test(a.description))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || b.luid - a.luid)
}

export function adapterLuidFor(pattern) {
  const hit = luidCandidatesFor(pattern)[0]
  return hit ? String(hit.luid) : null
}

export async function verifyVendorLuid(pattern, luids = null) {
  const { chromium } = await import('./cdp-browser.mjs')
  const candidates = luids && luids.length
    ? luids.map(String)
    : luidCandidatesFor(pattern).map((a) => String(a.luid))
  const re = new RegExp(pattern, 'i')
  const results = []
  for (const luid of candidates) {
    const browser = await chromium.launch({ args: [...ANGLE_D3D11_ARGS, `--use-adapter-luid=0,${luid}`] })
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
      const probe = await probeGpu(page)
      results.push({
        luid,
        rasterizer: rasterizerClass(probe),
        renderer: probe.renderer,
        vendorMatches: re.test(probe.haystack || ''),
      })
    } finally {
      await browser.close()
    }
  }
  return results
}

function flagValue(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

async function main() {
  const { chromium } = await import('./cdp-browser.mjs')
  const verifyVendor = flagValue('verify-luid')
  if (verifyVendor) {
    const pattern = VENDOR_ADAPTER_PATTERNS[verifyVendor] || verifyVendor
    const only = flagValue('luids')
    const results = await verifyVendorLuid(pattern, only ? only.split(',') : null)
    console.log(JSON.stringify({ vendor: verifyVendor, pattern, results }, null, 2))
    return
  }
  const url = flagValue('url')
  const accelerated = process.argv.includes('--accelerated')
  const browser = await chromium.launch({ args: gpuArgs({ accelerated }) })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' })
    const gpu = await assertGpu(page, {
      requireAccelerated: process.argv.includes('--require-accelerated'),
      expectVendor: flagValue('expect-vendor'),
    })
    console.log(JSON.stringify({ ...gpu, url: url || 'about:blank' }, null, 2))
  } finally {
    await browser.close()
  }
}

const invokedAsScript = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  main().catch(e => {
    console.error(`[gpu-probe] ${e.message}`)
    process.exit(1)
  })
}
