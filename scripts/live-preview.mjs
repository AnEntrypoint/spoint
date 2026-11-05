#!/usr/bin/env node
import { existsSync, watch, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = process.cwd()
const DEBOUNCE_MS = 300

const argv = process.argv.slice(2)
const outDir = resolve(PROJECT, argv.find(a => !a.startsWith('--')) || '.gm/live-preview')
const watchRoots = [...new Set([join(SDK_ROOT, 'client'), join(SDK_ROOT, 'src'), join(SDK_ROOT, 'apps'), resolve(PROJECT, 'apps')])].filter(existsSync)

let build = 0
let running = null
let queued = false
let timer = null

function runExport() {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [join(SDK_ROOT, 'scripts/static-export.mjs'), outDir], { stdio: 'inherit', cwd: PROJECT })
    child.on('exit', code => resolvePromise(code === 0))
  })
}

async function rebuild() {
  if (running) { queued = true; return running }
  running = (async () => {
    do {
      queued = false
      const ok = await runExport()
      if (ok) {
        build += 1
        writeFileSync(join(outDir, '__preview.json'), JSON.stringify({ build, builtAt: new Date().toISOString() }) + '\n')
        console.log(`[live-preview] build ${build} ready at ${relative(PROJECT, outDir) || '.'}/`)
      } else {
        console.error('[live-preview] export failed; waiting for the next change')
      }
    } while (queued)
    running = null
  })()
  return running
}

function scheduleRebuild(file) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    console.log(`[live-preview] change in ${file ?? 'tree'}`)
    rebuild()
  }, DEBOUNCE_MS)
}

await rebuild()
for (const root of watchRoots) {
  watch(root, { recursive: true }, (_event, file) => {
    if (file && /(^|[\\/])(\.glb-cache|node_modules|\.git|\.gm)([\\/]|$)/.test(file)) return
    scheduleRebuild(file)
  })
}
console.log(`[live-preview] watching ${watchRoots.map(r => relative(PROJECT, r) || '.').join(', ')}; open index.html?singleplayer&livereload=1 from ${relative(PROJECT, outDir) || '.'}/`)
