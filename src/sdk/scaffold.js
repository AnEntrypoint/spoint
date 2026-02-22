import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
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
  console.log(`[scaffold] run 'spoint' to start the server`)
}
