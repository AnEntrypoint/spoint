import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = process.argv.find(a => a.startsWith('--module='))?.slice('--module='.length)
const target = modulePath ? resolve(modulePath) : join(ROOT, 'src', 'static', 'containedFile.js')
const { containedRealFile } = await import(pathToFileURL(target).href)

const failures = []
const report = (name, ok, detail) => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
  if (!ok) failures.push(name)
}

const fixture = mkdtempSync(join(tmpdir(), 'static-containment-'))
try {
  const repo = join(fixture, 'repo')
  const outside = join(fixture, 'outside')
  const write = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
  write(join(repo, 'node_modules', 'plain', 'index.js'), 'plain')
  write(join(repo, 'packages', 'ws', 'index.js'), 'workspace')
  write(join(repo, 'other', 'file.js'), 'sibling')
  write(join(repo, 'client', 'real.js'), 'client')
  write(join(outside, 'secret.js'), 'secret')
  symlinkSync(join(repo, 'packages', 'ws'), join(repo, 'node_modules', 'ws'), 'dir')
  symlinkSync(outside, join(repo, 'node_modules', 'escape'), 'dir')
  symlinkSync(join(repo, 'other'), join(repo, 'node_modules', 'sibling'), 'dir')
  symlinkSync(join(repo, 'packages', 'ws', 'index.js'), join(repo, 'client', 'ws-link.js'), 'file')
  const nodeModules = join(repo, 'node_modules')

  report('plain-node-modules-file-served', containedRealFile(join(nodeModules, 'plain', 'index.js'), nodeModules) === true, 'a real file under node_modules')
  report('workspace-link-served', containedRealFile(join(nodeModules, 'ws', 'index.js'), nodeModules) === true, 'node_modules/ws -> packages/ws (npm workspace link)')
  report('escaping-link-refused', containedRealFile(join(nodeModules, 'escape', 'secret.js'), nodeModules) === false, 'node_modules/escape -> a directory outside the repo')
  report('sibling-link-refused', containedRealFile(join(nodeModules, 'sibling', 'file.js'), nodeModules) === false, 'node_modules/sibling -> repo/other, not packages/')
  report('path-outside-base-refused', containedRealFile(join(repo, 'packages', 'ws', 'index.js'), nodeModules) === false, 'a path that is not under the served directory')
  report('client-link-into-packages-refused', containedRealFile(join(repo, 'client', 'ws-link.js'), join(repo, 'client')) === false, 'a client/ symlink into packages/ is not a workspace link')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

const label = modulePath ? `module ${modulePath}` : 'src/static/containedFile.js'
if (failures.length === 0) console.log(`RESULT: PASS ${label}: 6 of 6 containment checks hold`)
else console.log(`RESULT: FAIL ${label}: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
