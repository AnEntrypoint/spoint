#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../src/sdk/AppManifest.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.error('Usage: node bin/marketplace-install.js <app-name> [--registry <url>] [--dir <apps-dir>]')
  process.exit(1)
}

const args = process.argv.slice(2)
let appName = null
let registryUrl = process.env.MARKETPLACE_REGISTRY || 'http://localhost:3100'
let appsDir = join(process.cwd(), 'apps')

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--registry' && i + 1 < args.length) {
    registryUrl = args[++i]
  } else if (args[i] === '--dir' && i + 1 < args.length) {
    appsDir = args[++i]
  } else if (!appName) {
    appName = args[i]
  } else {
    usage()
  }
}

if (!appName) usage()

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  return res.json()
}

async function main() {
  console.log(`Registry: ${registryUrl}`)
  console.log(`App: ${appName}`)
  console.log(`Install dir: ${appsDir}`)

  console.log(`Fetching manifest for "${appName}"...`)
  let manifest
  try {
    manifest = await fetchJson(`${registryUrl}/manifest/${encodeURIComponent(appName)}`)
  } catch (err) {
    console.error(`Failed to fetch manifest: ${err.message}`)
    process.exit(1)
  }

  const validation = validateManifest(manifest)
  if (!validation.valid) {
    console.error('Manifest validation failed:')
    for (const err of validation.errors) console.error(`  - ${err}`)
    process.exit(1)
  }
  console.log(`  ${manifest.name}@${manifest.version} -- ${manifest.title}`)

  const targetDir = join(appsDir, manifest.name)
  if (existsSync(targetDir)) {
    console.error(`Target directory already exists: ${targetDir}`)
    console.error('Remove it first or use a different app name.')
    process.exit(1)
  }

  let sourceFiles = null
  if (manifest.downloadUrl) {
    console.log(`Downloading bundle from ${manifest.downloadUrl}...`)
    try {
      const res = await fetch(manifest.downloadUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      sourceFiles = await res.json()
    } catch (err) {
      console.error(`Failed to download bundle: ${err.message}`)
      process.exit(1)
    }
  } else {
    console.log('No downloadUrl in manifest; creating minimal install from manifest.')
  }

  mkdirSync(targetDir, { recursive: true })

  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

  if (sourceFiles) {
    for (const [filename, content] of Object.entries(sourceFiles)) {
      const filePath = join(targetDir, filename)
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content, 'utf-8')
      console.log(`  Wrote ${filename}`)
    }
  }

  console.log(`Installed ${manifest.name}@${manifest.version} to ${targetDir}`)
  console.log('Done.')
}

main().catch(err => {
  console.error('Install failed:', err.message)
  process.exit(1)
})