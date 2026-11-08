import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './lib/cdp-browser.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' }
const SIZE = 256
const DOT_SIZE = 1.4
const CAMERA_D = 10
const FOV_DEG = 50
const PX_PER_M = (SIZE / 2) / (CAMERA_D * Math.tan((FOV_DEG / 2) * Math.PI / 180))
const TOLERANCE_PX = 4

const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8')
const IMPORT_MAP = INDEX_HTML.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>crowd dot render witness</title><body style="margin:0;background:#000"><script type="importmap">${IMPORT_MAP}</script><script type="module" src="/__witness/page.mjs"></script></body>`

const PAGE_LINES = [
  'import * as THREE from "three"',
  'window.addEventListener("error", (e) => { window.__error = String(e.message) })',
  `const SIZE = ${SIZE}`,
  'const canvas = document.createElement("canvas")',
  'canvas.width = SIZE',
  'canvas.height = SIZE',
  'document.body.append(canvas)',
  'try {',
  '  const { createCrowdDotRenderer } = await import("/core/PlayerLOD.js")',
  '  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })',
  '  renderer.setSize(SIZE, SIZE, false)',
  '  renderer.setPixelRatio(1)',
  '  renderer.setClearColor(0x000000, 1)',
  '  const gl = renderer.getContext()',
  '  const shot = (scene, camera) => {',
  '    renderer.render(scene, camera)',
  '    const px = new Uint8Array(SIZE * SIZE * 4)',
  '    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px)',
  '    let n = 0, minX = SIZE, maxX = -1',
  '    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {',
  '      const i = (y * SIZE + x) * 4',
  '      if (px[i] + px[i + 1] + px[i + 2] > 24) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x }',
  '    }',
  '    return { n, w: maxX >= 0 ? maxX - minX + 1 : 0 }',
  '  }',
  '  const run = (dots, cx, cz, side) => {',
  '    const scene = new THREE.Scene()',
  '    const rec = createCrowdDotRenderer(scene, { renderer, dotSize: 1.4, capacity: 64 })',
  '    rec.update(dots, 0)',
  '    const material = rec.instancedMesh.material',
  '    if (side !== undefined) { material.side = side; material.needsUpdate = true }',
  '    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500)',
  `    camera.position.set(cx, 0, cz + ${CAMERA_D})`,
  '    camera.lookAt(cx, 0, cz)',
  '    const out = shot(scene, camera)',
  '    out.side = material.side',
  '    out.count = rec.count',
  '    rec.dispose()',
  '    return out',
  '  }',
  '  window.__result = {',
  '    single: run([{ x: 0, y: 0, z: 0 }], 0, 0),',
  '    doubleSided: run([{ x: 0, y: 0, z: 0 }], 0, 0, THREE.DoubleSide),',
  '    bucket4: run([[0, 0, 4]], 12.5, 12.5),',
  '    bucket9: run([[0, 0, 9]], 12.5, 12.5),',
  '  }',
  '  renderer.dispose()',
  '} catch (e) {',
  '  window.__error = String(e && e.stack ? e.stack : e)',
  '}',
]
const PAGE_MODULE = PAGE_LINES.join('\n') + '\n'

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html')
    res.end(PAGE_HTML)
    return
  }
  if (url.pathname === '/__witness/page.mjs') {
    res.setHeader('content-type', 'text/javascript')
    res.end(PAGE_MODULE)
    return
  }
  const relative = decodeURIComponent(url.pathname)
  const base = relative.startsWith('/node_modules/') ? ROOT : path.join(ROOT, 'client')
  const file = path.resolve(base, '.' + relative)
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})

const widthPx = scale => DOT_SIZE * scale * PX_PER_M
const bucketScale = count => DOT_SIZE * Math.min(3, 0.6 + Math.sqrt(count) * 0.35)

async function renderPage(port) {
  const browser = await launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  let page = null
  try {
    page = await browser.newPage()
    await page.goto('http://127.0.0.1:' + port + '/')
    const deadline = Date.now() + 120000
    for (;;) {
      const state = await page.evaluate(() => ({ result: window.__result ?? null, error: window.__error ?? null }))
      if (state.error) throw new Error('page error: ' + state.error)
      if (state.result) return state.result
      if (Date.now() > deadline) throw new Error('render did not finish')
      await new Promise(r => setTimeout(r, 300))
    }
  } finally {
    if (page) await page.close()
    await browser.close()
  }
}

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
let failures = []
try {
  const res = await renderPage(port)
  const checks = [
    ['the dot as shipped (FrontSide) draws dot pixels', res.single.n > 0, `side ${res.single.side}, ${res.single.n} pixels`],
    ['the control with DoubleSide draws dot pixels', res.doubleSided.n > 0, `${res.doubleSided.n} pixels`],
    ['a single dot is 1.4 m wide, the instance scale applied once', Math.abs(res.single.w - widthPx(DOT_SIZE)) <= TOLERANCE_PX, `got ${res.single.w} px, expected ${widthPx(DOT_SIZE).toFixed(1)} px`],
    ['a count-4 bucket dot is 1.4 x its scale wide, applied once', Math.abs(res.bucket4.w - widthPx(bucketScale(4))) <= TOLERANCE_PX, `got ${res.bucket4.w} px, expected ${widthPx(bucketScale(4)).toFixed(1)} px`],
    ['a count-9 bucket dot is 1.4 x its scale wide, applied once', Math.abs(res.bucket9.w - widthPx(bucketScale(9))) <= TOLERANCE_PX, `got ${res.bucket9.w} px, expected ${widthPx(bucketScale(9)).toFixed(1)} px`],
  ]
  for (const [name, ok, detail] of checks) {
    console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
    if (!ok) failures.push(name)
  }
  console.log(JSON.stringify(res))
} finally {
  server.close()
}
if (failures.length) {
  console.log(`RESULT: FAIL ${failures.length} check(s): ${failures.join('; ')}`)
  process.exitCode = 1
} else {
  console.log('RESULT: PASS the WebGL crowd dots draw with the material as shipped, and their on-screen width is the dot size times the instance scale, applied once')
}
