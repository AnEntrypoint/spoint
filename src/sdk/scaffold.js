import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

const LIB_SHIM = /^export \* from '\.\.\/\.\.\/(src\/[^']+)'/
const ENGINE_SIBLING_IMPORTS = [
  [/'\.\.\/protocol\/ComponentSchema\.js'/g, "'./ComponentSchema.js'"],
  [/'\.\.\/apps\/ComponentPool\.js'/g, "'./ComponentPool.js'"]
]
const ENGINE_DIR_IMPORT = /'\.\.\/(netcode|fluid|game|sdk)\//g

function materializeLibShim(s, d) {
  const target = LIB_SHIM.exec(readFileSync(s, 'utf8'))?.[1]
  if (!target) { copyFileSync(s, d); return }
  let source = readFileSync(join(SDK_ROOT, target), 'utf8')
  for (const [from, to] of ENGINE_SIBLING_IMPORTS) source = source.replace(from, to)
  source = source.replace(ENGINE_DIR_IMPORT, (m, dir) => `'${relative(dirname(d), join(SDK_ROOT, 'src', dir)).split(sep).join('/')}/`)
  writeFileSync(d, source)
}

function copyDir(src, dest, copyFile = copyFileSync) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d, entry.name === '_lib' ? materializeLibShim : copyFile)
    else copyFile(s, d)
  }
}

export async function scaffold() {
  const cwd = process.cwd()
  const localApps = resolve(cwd, 'apps')
  if (existsSync(localApps)) {
    console.log(`[scaffold] apps/ already exists at ${localApps}, skipping`)
    return
  }
  const sdkApps = join(SDK_ROOT, 'apps')
  copyDir(sdkApps, localApps)
  console.log(`[scaffold] created apps/ at ${localApps}`)
  let result = spawnSync('bunx', ['skills', 'add', 'AnEntrypoint/spawnpoint', '--agent', '*', '--skill', 'spoint', '--yes'], { stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    result = spawnSync('npx', ['-y', 'skills', 'add', 'AnEntrypoint/spawnpoint', '--agent', '*', '--skill', 'spoint', '--yes'], { stdio: 'inherit', shell: true })
  }
  if (result.status !== 0) console.warn('[scaffold] skills install failed, continuing without it')
  console.log(`[scaffold] run 'spoint' to start the server`)
}
