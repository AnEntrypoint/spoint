import { createServer } from 'node:http'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const { createStaticHandler } = await import(pathToFileURL(join(ROOT, 'src/sdk/StaticHandler.js')).href)

const SECRET = 'OUTSIDE-SECRET-7f3a'
const sandbox = mkdtempSync(join(tmpdir(), 'spoint-static-'))
const served = join(sandbox, 'served')
const outside = join(sandbox, 'outside')
mkdirSync(served)
mkdirSync(outside)
writeFileSync(join(served, 'index.html'), '<!doctype html>INSIDE-INDEX')
writeFileSync(join(served, 'a.js'), 'export const inside = 1')
writeFileSync(join(outside, 'secret.txt'), SECRET)
symlinkSync(join(outside, 'secret.txt'), join(served, 'link.txt'))
symlinkSync(outside, join(served, 'outdir'))

const handler = createStaticHandler([{ prefix: '/', dir: served }])
const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end() }) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const get = (path) => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    const chunks = []
    res.on('data', (d) => chunks.push(d))
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', fail)
  req.end()
})

const leaks = (r) => r.body.includes(SECRET)
try {
  const control = await get('/a.js')
  check('control: a file inside the served directory is served', control.status === 200 && control.body.includes('inside = 1'), `status=${control.status}`)

  const index = await get('/index.html')
  check('control: index.html inside the served directory is served', index.status === 200 && index.body.includes('INSIDE-INDEX'), `status=${index.status}`)

  const dotdot = await get('/../outside/secret.txt')
  check('a raw ../ traversal does not reveal a file outside the served directory', !leaks(dotdot), `status=${dotdot.status}`)

  const encoded = await get('/%2e%2e/outside/secret.txt')
  check('a percent-encoded ../ traversal does not reveal a file outside the served directory', !leaks(encoded), `status=${encoded.status}`)

  const deep = await get('/a.js/../../outside/secret.txt')
  check('a traversal that starts inside a real file does not reveal the outside file', !leaks(deep), `status=${deep.status}`)

  const link = await get('/link.txt')
  check('a symlink inside the served directory that points outside is refused (realpath check)', !leaks(link) && link.status !== 200, `status=${link.status}`)

  const linkDir = await get('/outdir/secret.txt')
  check('a symlinked directory that points outside is refused through its realpath', !leaks(linkDir) && linkDir.status !== 200, `status=${linkDir.status}`)

  check('every static response carries COOP same-origin and COEP require-corp', [control, index, dotdot, link].every((r) => r.headers['cross-origin-opener-policy'] === 'same-origin' && r.headers['cross-origin-embedder-policy'] === 'require-corp'), `coop=${control.headers['cross-origin-opener-policy']} coep=${control.headers['cross-origin-embedder-policy']}`)
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
console.log('RESULT: PASS static handler serves only files whose resolved path and realpath stay under the served directory, and sends COOP/COEP')
process.exit(0)
