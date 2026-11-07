import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launch } from './lib/cdp-browser.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REF = process.env.READINESS_REF || 'HEAD'
const refSource = execFileSync('git', ['-C', ROOT, 'show', REF + ':client/core/ProgramReadiness.js'], { encoding: 'utf8' })
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wgsl': 'text/plain' }

const PAGE_HTML = '<!doctype html><meta charset="utf-8"><title>program-readiness render witness</title><body style="margin:0;background:#000"><script type="module" src="/__witness/page.mjs?variant=VARIANT"></script></body>'

const PAGE_LINES = [
  'import * as THREE from "/node_modules/three/build/three.webgpu.js"',
  'const variant = new URL(import.meta.url).searchParams.get("variant")',
  'const MODULE_URLS = { ref: "/__ref/ProgramReadiness.js", working: "/client/core/ProgramReadiness.js" }',
  'const ready = await import(MODULE_URLS[variant])',
  'const SIZE = 256',
  'const canvas = document.createElement("canvas")',
  'canvas.width = SIZE',
  'canvas.height = SIZE',
  'document.body.append(canvas)',
  'try {',
  '  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false })',
  '  await renderer.init()',
  '  const scene = new THREE.Scene()',
  '  scene.background = new THREE.Color(0x203040)',
  '  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)',
  '  camera.position.set(0, 1, 6)',
  '  camera.lookAt(0, 0, 0)',
  '  for (let i = 0; i < 12; i++) {',
  '    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 12, 0.7, 0.5), roughness: 0.4 })',
  '    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material)',
  '    mesh.position.set((i % 4) - 1.5, Math.floor(i / 4) - 1, -i * 0.05)',
  '    scene.add(mesh)',
  '  }',
  '  const light = new THREE.DirectionalLight(0xffffff, 2)',
  '  light.position.set(2, 3, 4)',
  '  scene.add(light)',
  '  const installed = ready.installAsyncRenderPipelines(renderer)',
  '  let maxPending = 0',
  '  for (let i = 0; i < 60; i++) {',
  '    renderer.render(scene, camera)',
  '    maxPending = Math.max(maxPending, ready.pendingProgramCount(renderer))',
  '    await new Promise((r) => setTimeout(r, 50))',
  '  }',
  '  const settled = await ready.whenProgramsReady(renderer, 30000)',
  '  const target = new THREE.RenderTarget(SIZE, SIZE)',
  '  renderer.setRenderTarget(target)',
  '  renderer.render(scene, camera)',
  '  renderer.setRenderTarget(null)',
  '  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE)',
  '  const digest = await crypto.subtle.digest("SHA-256", pixels)',
  '  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")',
  '  window.__result = { installed: installed === true, maxPending, settled: String(settled ?? null), hash, bytes: pixels.byteLength }',
  '} catch (e) {',
  '  window.__error = String(e && e.stack ? e.stack : e)',
  '}',
]
const PAGE_MODULE = PAGE_LINES.join('\n') + '\n'

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html')
    res.end(PAGE_HTML.replace('VARIANT', url.searchParams.get('variant') || 'working'))
    return
  }
  if (url.pathname === '/__witness/page.mjs') {
    res.setHeader('content-type', 'text/javascript')
    res.end(PAGE_MODULE)
    return
  }
  if (url.pathname === '/__ref/ProgramReadiness.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(refSource)
    return
  }
  const file = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname))
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})

async function runVariant(port, variant) {
  const browser = await launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  let page = null
  try {
    page = await browser.newPage()
    await page.goto('http://127.0.0.1:' + port + '/?variant=' + variant)
    const deadline = Date.now() + 180000
    for (;;) {
      const state = await page.evaluate(() => ({ result: window.__result ?? null, error: window.__error ?? null }))
      if (state.error) throw new Error('page error (' + variant + '): ' + state.error)
      if (state.result) return Object.assign({ variant }, state.result)
      if (Date.now() > deadline) throw new Error('render did not finish for ' + variant)
      await new Promise((r) => setTimeout(r, 500))
    }
  } finally {
    if (page) await page.close()
    await browser.close()
  }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
let pass = false
try {
  const refA = await runVariant(port, 'ref')
  const refB = await runVariant(port, 'ref')
  const working = await runVariant(port, 'working')
  const deterministic = refA.hash === refB.hash
  const exercised = refA.maxPending > 0
  const matches = working.installed === refA.installed && working.hash === refA.hash
  pass = deterministic && exercised && matches
  console.log(JSON.stringify({ ref: refA, refRepeat: refB, working, deterministic, exercised, matches }))
  console.log(pass
    ? 'RESULT: PASS working ProgramReadiness.js renders the same pixels and readiness as ' + REF + ' on the same scene'
    : 'RESULT: FAIL working ProgramReadiness.js differs from ' + REF + ' (deterministic=' + deterministic + ' exercised=' + exercised + ' matches=' + matches + ')')
} finally {
  server.close()
}
process.exitCode = pass ? 0 : 1
