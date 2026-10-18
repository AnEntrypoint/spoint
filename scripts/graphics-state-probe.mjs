#!/usr/bin/env node
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu, gpuLaunchArgs, gpuModeFlag } from './lib/gpu-probe.mjs'

const DEFAULT_URL = 'http://localhost:3000/'
const URL_ARG = process.argv.find(a => a.startsWith('--url='))
const TARGET_URL = URL_ARG ? URL_ARG.slice('--url='.length) : DEFAULT_URL
const GPU_MODE = gpuModeFlag('gpu', 'software')

function readGraphicsGlobals() {
  const present = (value) => value !== undefined && value !== null
  const rendererInfo = window.__rendererInfo
  const shaderWarmup = window.__lastShaderWarmup
  const governor = window.__qualityGovernorState
  const overdraw = window.__overdrawProbe
  let overdrawCounters = null
  if (present(overdraw) && typeof overdraw.counters === 'function') {
    overdrawCounters = overdraw.counters()
  }
  return {
    rendererInfo: { installed: present(rendererInfo), value: present(rendererInfo) ? rendererInfo : null },
    lastShaderWarmup: {
      installed: present(shaderWarmup),
      value: present(shaderWarmup) ? shaderWarmup : null,
      compileFailures: present(shaderWarmup) && Array.isArray(shaderWarmup.compileFailures) ? shaderWarmup.compileFailures : null,
    },
    qualityGovernorState: { installed: present(governor), value: present(governor) ? governor : null },
    overdrawProbe: {
      installed: present(overdraw),
      hasCounters: typeof overdraw?.counters === 'function',
      counters: overdrawCounters,
    },
  }
}

async function main() {
  const browser = await chromium.launch({ args: gpuLaunchArgs(GPU_MODE) })
  try {
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' })
    const gpu = await assertGpu(page, {
      requireAccelerated: GPU_MODE.accelerated,
      expectVendor: GPU_MODE.vendor,
    })
    const globals = await page.evaluate(readGraphicsGlobals)
    const report = {
      url: TARGET_URL,
      gpu: { rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.vendor, adapter: gpu.adapter },
      ...globals,
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch(e => {
  console.error(`[graphics-state-probe] ${e.message}`)
  process.exit(1)
})
