import { createServer, request } from 'node:http'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_GLB = join(ROOT, 'apps/maps/aim_sillos.glb')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const { createStaticHandler } = await import(pathToFileURL(join(ROOT, 'src/sdk/StaticHandler.js')).href)

const sandbox = mkdtempSync(join(tmpdir(), 'spoint-derived-'))
const served = join(sandbox, 'served')
const outside = join(sandbox, 'outside')
mkdirSync(served)
mkdirSync(outside)
copyFileSync(SAMPLE_GLB, join(outside, 'secret.glb'))
copyFileSync(SAMPLE_GLB, join(served, 'real.glb'))
symlinkSync(join(outside, 'secret.glb'), join(served, 'link.glb'))
symlinkSync(outside, join(served, 'outdir'))

const handler = createStaticHandler([{ prefix: '/', dir: served }])
const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end() }) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const get = (path) => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    const chunks = []
    res.on('data', (d) => chunks.push(d))
    res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks) }))
  })
  req.on('error', fail)
  req.end()
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isGlb = (r) => r.status === 200 && r.body.length > 4 && r.body.slice(0, 4).toString('latin1') === 'glTF'

const pollForBake = async (path, seconds) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < seconds * 1000) {
    last = await get(path)
    if (last.status === 200) break
    await sleep(1000)
  }
  return last
}

try {
  const control = await pollForBake('/real.glb.prog/model.progressive.glb', 60)
  check('control: a bake of a real .glb inside the served root is served as a glTF', isGlb(control), `status=${control.status} bytes=${control.body.length}`)

  const sourceBefore = readFileSync(join(outside, 'secret.glb'))
  const fileLink = await pollForBake('/link.glb.prog/model.progressive.glb', 20)
  check('a .glb symlink that points outside the served root is not baked and served (file symlink, derived bytes)', !isGlb(fileLink), `status=${fileLink.status} bytes=${fileLink.body.length}`)

  const dirLink = await get('/outdir/secret.glb.prog/model.progressive.glb')
  await sleep(2000)
  check('a bake through a symlinked directory writes no cache outside the served root (.progressive-cache)', !existsSync(join(outside, '.progressive-cache')), `status=${dirLink.status}`)
  check('the source outside the served root is not modified by a bake request', readFileSync(join(outside, 'secret.glb')).equals(sourceBefore))

  await get('/outdir/secret.glb.ktx2/0.ktx2')
  await sleep(4000)
  check('a ktx2 extract through a symlinked directory writes no cache outside the served root (.glb-cache, .ktx2-cache)', !existsSync(join(outside, '.glb-cache')) && !existsSync(join(outside, '.ktx2-cache')), `glb-cache=${existsSync(join(outside, '.glb-cache'))} ktx2-cache=${existsSync(join(outside, '.ktx2-cache'))}`)
} finally {
  await new Promise((r) => server.close(r))
  rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS derived .glb.prog and .glb.ktx2 responses and caches stay inside the served root')
process.exit(0)
