import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from './cdp-browser.mjs'
import { gpuArgs } from './gpu-probe.mjs'

export const GPU_CONTROL_PROBE_MS = 2000
export const GPU_CONTROL_SENSITIVE_P50_MS = 30
export const GPU_CONTROL_MIN_P50_MS = 20
export const GPU_CONTROL_SPREAD_FACTOR = 1.25

const WIDTH = 1280
const HEIGHT = 720
const PASSES = 2
const LADDER = [1024, 2048, 3072, 4096, 8192]
const READY_FRAMES = 3

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function vertexSource() {
  return [
    '#version 300 es',
    'void main() {',
    '  float x = (gl_VertexID == 1) ? 3.0 : -1.0;',
    '  float y = (gl_VertexID == 2) ? 3.0 : -1.0;',
    '  gl_Position = vec4(x, y, 0.0, 1.0);',
    '}',
  ].join('\n')
}

function fragmentSource(iterations) {
  return [
    '#version 300 es',
    'precision highp float;',
    'uniform float uSeed;',
    'out vec4 outColor;',
    'void main() {',
    '  float acc = 0.0;',
    `  for (int i = 0; i < ${iterations}; i++) {`,
    '    acc += sin(float(i) * 0.37 + uSeed + gl_FragCoord.x * 0.013) * cos(gl_FragCoord.y * 0.017 - uSeed);',
    '  }',
    '  outColor = vec4(abs(acc) * 0.0025, 0.0, 0.0, 1.0);',
    '}',
  ].join('\n')
}

function controlScript(iterations) {
  return [
    'const canvas = document.getElementById("gpu-control");',
    'const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });',
    'if (!gl) { window.__gpuControlError = "webgl2 unavailable"; } else {',
    '  const compile = (type, src) => {',
    '    const shader = gl.createShader(type);',
    '    gl.shaderSource(shader, src);',
    '    gl.compileShader(shader);',
    '    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;',
    '  };',
    `  const vs = compile(gl.VERTEX_SHADER, ${JSON.stringify(vertexSource())});`,
    `  const fs = compile(gl.FRAGMENT_SHADER, ${JSON.stringify(fragmentSource(iterations))});`,
    '  if (!vs || !fs) {',
    '    window.__gpuControlError = "shader compile failed";',
    '  } else {',
    '    const program = gl.createProgram();',
    '    gl.attachShader(program, vs);',
    '    gl.attachShader(program, fs);',
    '    gl.linkProgram(program);',
    '    gl.useProgram(program);',
    '    gl.bindVertexArray(gl.createVertexArray());',
    '    const pixel = new Uint8Array(4);',
    '    const seed = gl.getUniformLocation(program, "uSeed");',
    '    let frames = 0;',
    '    function draw() {',
    '      frames++;',
    '      const t0 = performance.now();',
    `      for (let pass = 0; pass < ${PASSES}; pass++) {`,
    '        gl.uniform1f(seed, frames * 0.13 + pass * 0.7);',
    '        gl.drawArrays(gl.TRIANGLES, 0, 3);',
    '      }',
    '      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);',
    '      window.__gpuControlFrameMs = performance.now() - t0;',
    '      window.__gpuControlFrames = frames;',
    '      requestAnimationFrame(draw);',
    '    }',
    '    requestAnimationFrame(draw);',
    '  }',
    '}',
  ].join('\n')
}

function controlHtml(iterations) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>gpu control</title></head>',
    '<body style="margin:0;background:#000;overflow:hidden">',
    `<canvas id="gpu-control" width="${WIDTH}" height="${HEIGHT}"></canvas>`,
    '<script>',
    controlScript(iterations),
    '</script></body></html>',
  ].join('\n')
}

function controlFile(iterations, tag) {
  const path = join(tmpdir(), `spoint-gpu-control-${tag}-${iterations}.html`)
  writeFileSync(path, controlHtml(iterations))
  return path
}

function frameProbe(page, ms) {
  return page.evaluate((probeMs) => new Promise((resolve) => {
    const samples = []
    const t0 = performance.now()
    function tick() {
      const dt = window.__gpuControlFrameMs
      if (typeof dt === 'number') samples.push(dt)
      if (performance.now() - t0 < probeMs) requestAnimationFrame(tick)
      else resolve(samples)
    }
    requestAnimationFrame(tick)
  }), ms)
}

async function waitForControlFrames(page) {
  let error = null
  let frames = 0
  for (let attempt = 0; attempt < 90 && frames < READY_FRAMES && !error; attempt++) {
    const state = await page.evaluate(() => ({
      frames: window.__gpuControlFrames || 0,
      error: window.__gpuControlError || null,
    })).catch(() => null)
    if (state) {
      frames = state.frames
      error = state.error
    }
    if (!error && frames < READY_FRAMES) await new Promise(r => setTimeout(r, 200))
  }
  if (error) throw new Error(`the gpu control page could not draw: ${error}`)
  if (frames < READY_FRAMES) throw new Error(`the gpu control page presented only ${frames} frame(s) before its cadence was measured`)
  return frames
}

export async function gpuControlProbe({ iterations, args, probeMs = GPU_CONTROL_PROBE_MS, tag = String(process.pid) }) {
  const file = controlFile(iterations, tag)
  let browser = null
  try {
    browser = await chromium.launch({ headless: true, args })
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
    await page.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded' })
    await waitForControlFrames(page)
    const deltas = await frameProbe(page, probeMs)
    if (!Array.isArray(deltas) || deltas.length === 0) return null
    const sorted = deltas.slice().sort((a, b) => a - b)
    return { iterations, samples: sorted.length, p50Ms: percentile(sorted, 0.5), worstMs: sorted[sorted.length - 1] }
  } finally {
    if (browser) await browser.close().catch(() => {})
    rmSync(file, { force: true })
  }
}

export async function gpuControlCalibrate({ args, probeMs = GPU_CONTROL_PROBE_MS, tag = String(process.pid) }) {
  let best = null
  for (const iterations of LADDER) {
    const probe = await gpuControlProbe({ iterations, args, probeMs, tag }).catch(() => null)
    if (!probe) continue
    const candidate = { ...probe, iterations }
    if (!best || candidate.p50Ms > best.p50Ms) best = candidate
    if (candidate.p50Ms >= GPU_CONTROL_SENSITIVE_P50_MS) return candidate
  }
  return best
}

export function gpuControlArgs({ accelerated, vendorArgs = [], unlockedRafArgs = [] }) {
  return [...gpuArgs({ accelerated }), ...vendorArgs, ...unlockedRafArgs]
}

export function gpuControlSensitive(probe) {
  return !!probe && probe.p50Ms >= GPU_CONTROL_MIN_P50_MS
}

export function gpuControlRate(probe) {
  if (!probe || !probe.iterations || !probe.p50Ms) return null
  return (probe.p50Ms * 1000) / probe.iterations
}

export function gpuControlSpread(before, after) {
  const rates = [gpuControlRate(before), gpuControlRate(after)].filter((r) => r != null && r > 0)
  if (rates.length < 2) return null
  return Math.max(...rates) / Math.min(...rates)
}
