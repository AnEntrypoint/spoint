import { pathToFileURL } from 'node:url'
import { angleBackendArgs, vendorGpuArgs, assertGpu, rasterizerOf } from '../../../scripts/lib/gpu-probe.mjs'

const ANGLE_BACKENDS = ['swiftshader', 'default', 'gl', 'gles', 'd3d9', 'd3d11', 'vulkan', 'metal']

const BACKEND_MARKERS = {
  swiftshader: /swiftshader|llvmpipe|softwarerasterizer|subzero|basic render/i,
  gl: /opengl/i,
  gles: /opengl\s*es/i,
  d3d9: /direct3d9|d3d9/i,
  d3d11: /direct3d11|d3d11/i,
  vulkan: /vulkan/i,
  metal: /metal/i,
  default: null,
}

const VENDOR_MARKERS = {
  nvidia: /nvidia|geforce|quadro|rtx/i,
  amd: /amd|radeon/i,
  intel: /intel|arc|iris|uhd/i,
  igpu: /intel|arc|iris|uhd/i,
}

const PASSTHROUGH_VENDORS = new Set(['', 'none', 'software', 'swiftshader', 'accelerated'])
const SOFTWARE_BACKENDS = new Set(['swiftshader'])

export function adapterLuidOf(args) {
  const hit = args.find((a) => a.startsWith('--use-adapter-luid=0,'))
  return hit ? hit.slice('--use-adapter-luid=0,'.length) : null
}

export function resolveLaunchArgs(backendRaw, vendorRaw, luids = {}) {
  const backend = String(backendRaw === undefined || backendRaw === null ? 'swiftshader' : backendRaw).toLowerCase()
  if (!ANGLE_BACKENDS.includes(backend)) {
    throw new Error(`backend-guard: ANGLE backend "${backendRaw}" is not one Chrome can honour (${ANGLE_BACKENDS.join(', ')})`)
  }
  const vendor = vendorRaw ? String(vendorRaw).toLowerCase() : null
  if (!vendor || PASSTHROUGH_VENDORS.has(vendor)) {
    return { backend, vendor: null, luid: null, args: angleBackendArgs(backend) }
  }
  if (!VENDOR_MARKERS[vendor]) {
    throw new Error(`backend-guard: GPU vendor "${vendorRaw}" is not one this box can pin (${Object.keys(VENDOR_MARKERS).join(', ')})`)
  }
  let pinned
  try {
    pinned = vendorGpuArgs(vendor, luids)
  } catch (e) {
    throw new Error(`backend-guard: GPU vendor "${vendor}" requested but not honoured -- ${e.message}`)
  }
  const args = pinned.map((a) => (a.startsWith('--use-angle=') ? `--use-angle=${backend}` : a))
  return { backend, vendor, luid: adapterLuidOf(args), args }
}

const GPU_PROBE_TIMEOUT_MS = 30000
const GPU_PROBE_RETRIES = 20
const GPU_PROBE_RETRY_DELAY_MS = 500

async function boundedEval(evalIn, src) {
  let timer = null
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`gpu probe did not answer within ${GPU_PROBE_TIMEOUT_MS} ms`)), GPU_PROBE_TIMEOUT_MS)
  })
  return Promise.race([evalIn(src), guard]).finally(() => clearTimeout(timer))
}

export function cdpPageOf(evalIn) {
  return {
    async evaluate(fn) {
      const src = `(${fn.toString()})()`
      let last = null
      for (let i = 0; i < GPU_PROBE_RETRIES; i++) {
        try {
          return await boundedEval(evalIn, src)
        } catch (e) {
          last = e
          if (i + 1 < GPU_PROBE_RETRIES) await new Promise((r) => setTimeout(r, GPU_PROBE_RETRY_DELAY_MS))
        }
      }
      throw last
    },
  }
}

export async function assertLiveBackend(evalIn, want, label = 'session') {
  const wantBackend = want && want.backend ? String(want.backend).toLowerCase() : null
  const wantVendor = want && want.vendor ? String(want.vendor).toLowerCase() : null
  const opts = {}
  if (wantBackend && !SOFTWARE_BACKENDS.has(wantBackend)) opts.requireAccelerated = true
  if (wantVendor && VENDOR_MARKERS[wantVendor]) opts.expectVendor = VENDOR_MARKERS[wantVendor].source
  let gpu
  try {
    gpu = await assertGpu(cdpPageOf(evalIn), opts)
  } catch (e) {
    const requested = [wantBackend && `backend "${wantBackend}"`, wantVendor && `vendor "${wantVendor}"`].filter(Boolean).join(' on ')
    throw new Error(`backend-guard: ${label} requested ${requested || 'an unpinned session'} -- ${e.message}`)
  }
  const haystack = gpu.haystack || ''
  if (!haystack) {
    throw new Error(`backend-guard: ${label} exposed no GPU renderer string, so the requested backend cannot be confirmed`)
  }
  const observed = ANGLE_BACKENDS.find((b) => BACKEND_MARKERS[b] && BACKEND_MARKERS[b].test(haystack)) || 'unknown'
  if (wantBackend && BACKEND_MARKERS[wantBackend] && !BACKEND_MARKERS[wantBackend].test(haystack)) {
    throw new Error(`backend-guard: ${label} requested ANGLE backend "${wantBackend}" but the live session renders on "${haystack}" (observed ${observed})`)
  }
  return { backend: observed, rasterizer: rasterizerOf(haystack), renderer: gpu.renderer, vendor: gpu.vendor, haystack }
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(resolveLaunchArgs(process.argv[2] || 'swiftshader', process.argv[3] || null).args.join(' '))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
