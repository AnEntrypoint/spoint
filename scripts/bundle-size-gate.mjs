#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const exec = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASELINE_PATH = join(ROOT, '.bundle-size-baseline.json')
const OUTFILE = join(ROOT, 'dist', 'client', 'app.js')
const THRESHOLD = 1.10
const MIN_PLAUSIBLE_BUNDLE_BYTES = 100_000
const UPDATE = process.argv.includes('--update-baseline')

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`[bundle-size-gate] baseline written: ${BASELINE_PATH}`)
  console.log(JSON.stringify(data, null, 2))
}

async function measureRealBundleSize() {
  console.log('[bundle-size-gate] running real bundle-client.mjs build ...')
  try {
    const { stdout } = await exec(process.execPath, ['scripts/bundle-client.mjs'], { cwd: ROOT, timeout: 120_000 })
    console.log(stdout.trim())
  } catch (e) {
    console.error('[bundle-size-gate] real build FAILED:\n', e.stderr || e.stack || e.message)
    process.exit(1)
  }
  if (!existsSync(OUTFILE)) throw new Error(`build reported success but ${OUTFILE} does not exist`)
  const bytes = statSync(OUTFILE).size
  if (!bytes || bytes < MIN_PLAUSIBLE_BUNDLE_BYTES) {
    throw new Error(`measured bundle size ${bytes} bytes is implausibly small (<100KB) -- treat as a build failure, not a real shrink`)
  }
  return bytes
}

async function main() {
  let bytes
  try {
    bytes = await measureRealBundleSize()
  } catch (e) {
    console.error('[bundle-size-gate] FAILED:\n', e.stack || e.message)
    process.exit(1)
  }

  const kb = (bytes / 1024).toFixed(1)
  console.log(`[bundle-size-gate] dist/client/app.js = ${bytes} bytes (${kb} KB)`)

  if (UPDATE) {
    writeBaseline({ bytes, file: 'dist/client/app.js' })
    console.log('[bundle-size-gate] baseline updated. PASS')
    process.exit(0)
  }

  const baseline = readBaseline()
  if (!baseline) {
    console.error('[bundle-size-gate] no baseline found. Run with --update-baseline to create one.')
    process.exit(1)
  }
  if (baseline.bytes == null) {
    console.error('[bundle-size-gate] baseline missing bytes. Run with --update-baseline to refresh.')
    process.exit(1)
  }

  const limit = baseline.bytes * THRESHOLD
  console.log(`[bundle-size-gate] baseline=${baseline.bytes} bytes limit=${limit.toFixed(0)} bytes (+10%) measured=${bytes} bytes`)

  if (bytes > limit) {
    console.error(`[bundle-size-gate] REGRESSION: ${bytes} bytes > ${limit.toFixed(0)} bytes (${((bytes / baseline.bytes - 1) * 100).toFixed(1)}% over baseline)`)
    process.exit(1)
  }

  console.log('[bundle-size-gate] PASS')
  process.exit(0)
}

main()
