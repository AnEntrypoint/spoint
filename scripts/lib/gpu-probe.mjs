import { pathToFileURL } from 'node:url'
import { chromium } from './cdp-browser.mjs'

export const SOFTWARE_ARGS = ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
export const ACCELERATED_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization']

const SOFTWARE_MARKERS = /swiftshader|llvmpipe|softwarerasterizer|basic render|mesa offscreen|subzero/i

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
    const parts = [renderer, vendor, adapter && adapter.vendor, adapter && adapter.description].filter(Boolean)
    const haystack = parts.join(' | ')
    return {
      accelerated: parts.length > 0 && !markers.test(haystack),
      renderer,
      vendor,
      adapter,
      haystack,
    }
  })
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

function flagValue(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

async function main() {
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
