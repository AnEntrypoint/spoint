import { createServer, request } from 'node:http'
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
const served2 = join(sandbox, 'served2')
const outside = join(sandbox, 'outside')
const vendor = join(outside, 'nm')
mkdirSync(served)
mkdirSync(join(served, 'node_modules'), { recursive: true })
mkdirSync(served2)
mkdirSync(vendor, { recursive: true })
writeFileSync(join(served, 'index.html'), '<!doctype html>INSIDE-INDEX')
writeFileSync(join(served, 'a.js'), 'export const inside = 1')
writeFileSync(join(served, 'node_modules', 'real.js'), 'export const nm = "NM-REAL"')
writeFileSync(join(served2, 'index.html'), '<!doctype html>SERVED2-INDEX')
writeFileSync(join(outside, 'secret.txt'), SECRET)
writeFileSync(join(vendor, 'pkg.js'), 'export const pkg = "JUNCTION-PKG"')
symlinkSync(join(outside, 'secret.txt'), join(served, 'link.txt'))
symlinkSync(outside, join(served, 'outdir'))
symlinkSync(join(outside, 'secret.txt'), join(served, 'node_modules', 'evil.txt'))
symlinkSync(outside, join(served, 'node_modules', 'evilpkg'))
symlinkSync(vendor, join(served2, 'node_modules'))
symlinkSync(join(outside, 'secret.txt'), join(vendor, 'nm-escape.txt'))

const serve = async (dir) => {
  const handler = createStaticHandler([{ prefix: '/', dir }])
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end() }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

const get = (port, path) => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    const chunks = []
    res.on('data', (d) => chunks.push(d))
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', fail)
  req.end()
})

const leaks = (r) => r.body.includes(SECRET)
const main = await serve(served)
const junction = await serve(served2)
try {
  const control = await get(main.port, '/a.js')
  check('control: a file inside the served directory is served', control.status === 200 && control.body.includes('inside = 1'), `status=${control.status}`)

  const index = await get(main.port, '/index.html')
  check('control: index.html inside the served directory is served', index.status === 200 && index.body.includes('INSIDE-INDEX'), `status=${index.status}`)

  const dotdot = await get(main.port, '/../outside/secret.txt')
  check('a raw ../ traversal does not reveal a file outside the served directory', !leaks(dotdot), `status=${dotdot.status}`)

  const encoded = await get(main.port, '/%2e%2e/outside/secret.txt')
  check('a percent-encoded ../ traversal does not reveal a file outside the served directory', !leaks(encoded), `status=${encoded.status}`)

  const deep = await get(main.port, '/a.js/../../outside/secret.txt')
  check('a traversal that starts inside a real file does not reveal the outside file', !leaks(deep), `status=${deep.status}`)

  const link = await get(main.port, '/link.txt')
  check('a symlink inside the served directory that points outside is refused (realpath check)', !leaks(link) && link.status !== 200, `status=${link.status}`)

  const linkDir = await get(main.port, '/outdir/secret.txt')
  check('a symlinked directory that points outside is refused through its realpath', !leaks(linkDir) && linkDir.status !== 200, `status=${linkDir.status}`)

  const nmReal = await get(main.port, '/node_modules/real.js')
  check('control: a real file under a node_modules directory inside the served root is served', nmReal.status === 200 && nmReal.body.includes('NM-REAL'), `status=${nmReal.status}`)

  const nmEvil = await get(main.port, '/node_modules/evil.txt')
  check('a symlink under a real node_modules directory that points outside is refused', !leaks(nmEvil) && nmEvil.status !== 200, `status=${nmEvil.status}`)

  const nmEvilDir = await get(main.port, '/node_modules/evilpkg/secret.txt')
  check('a symlinked directory under node_modules that points outside is refused', !leaks(nmEvilDir) && nmEvilDir.status !== 200, `status=${nmEvilDir.status}`)

  const junctionIndex = await get(junction.port, '/index.html')
  check('control: the served root of a node_modules junction still serves its own files', junctionIndex.status === 200 && junctionIndex.body.includes('SERVED2-INDEX'), `status=${junctionIndex.status}`)

  const junctionPkg = await get(junction.port, '/node_modules/pkg.js')
  check('a node_modules junction to a vendor tree outside the served root is served (legitimate worktree case)', junctionPkg.status === 200 && junctionPkg.body.includes('JUNCTION-PKG'), `status=${junctionPkg.status}`)

  const junctionEscape = await get(junction.port, '/node_modules/nm-escape.txt')
  check('a symlink inside the junction target that points outside the target is refused', !leaks(junctionEscape) && junctionEscape.status !== 200, `status=${junctionEscape.status}`)

  check('every static response carries COOP same-origin and COEP require-corp', [control, index, dotdot, link].every((r) => r.headers['cross-origin-opener-policy'] === 'same-origin' && r.headers['cross-origin-embedder-policy'] === 'require-corp'), `coop=${control.headers['cross-origin-opener-policy']} coep=${control.headers['cross-origin-embedder-policy']}`)
} finally {
  await main.close()
  await junction.close()
  rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS static handler serves only files whose resolved path and realpath stay under the served directory, or under a node_modules junction target, and sends COOP/COEP')
process.exit(0)
