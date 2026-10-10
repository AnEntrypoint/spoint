#!/usr/bin/env node

import { createServer } from 'node:http'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { validateManifest } from '../src/sdk/AppManifest.js'

const PORT = parseInt(process.env.PORT || '3100', 10)
const DATA_FILE = process.env.DATA_FILE || './registry-data.json'

let _registry = new Map()

class RegistryLoadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RegistryLoadError'
  }
}

function loadRegistry() {
  if (!existsSync(DATA_FILE)) return
  let entries
  try {
    entries = JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
  } catch (err) {
    throw new RegistryLoadError(`${DATA_FILE} is not valid JSON (${err.message}); refusing to start with an empty registry`)
  }
  if (!Array.isArray(entries) || !entries.every(e => e !== null && typeof e === 'object')) {
    throw new RegistryLoadError(`${DATA_FILE} does not hold a JSON array of app manifests; refusing to start with an empty registry`)
  }
  _registry = new Map(entries.map(e => [e.name, e]))
  console.log(`Loaded ${_registry.size} entries from ${DATA_FILE}`)
}

function saveRegistry(registry) {
  const tmp = `${DATA_FILE}.tmp`
  const payload = JSON.stringify([...registry.values()], null, 2)
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, payload, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, DATA_FILE)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch {
        const invalid = new Error('Invalid JSON body')
        invalid.code = 'INVALID_JSON'
        reject(invalid)
      }
    })
    req.on('error', reject)
  })
}

const CORE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

function coreVersion(version) {
  const match = CORE_VERSION.exec(String(version))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function isVersionGreater(next, stored) {
  const a = coreVersion(next)
  const b = coreVersion(stored)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  try {
    if (req.method === 'GET' && path === '/health') {
      jsonResponse(res, 200, { ok: true, count: _registry.size })
      return
    }

    if (req.method === 'GET' && path === '/index') {
      const entries = [..._registry.values()].map(m => ({
        name: m.name,
        version: m.version,
        title: m.title,
        description: m.description,
        author: m.author,
        tags: m.tags || [],
        license: m.license,
        icon: m.icon,
      }))
      jsonResponse(res, 200, entries)
      return
    }

    if (req.method === 'GET' && path === '/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      const tag = (url.searchParams.get('tag') || '').toLowerCase()
      let results = [..._registry.values()]

      if (q) {
        results = results.filter(m =>
          m.name.toLowerCase().includes(q) ||
          (m.title && m.title.toLowerCase().includes(q)) ||
          (m.description && m.description.toLowerCase().includes(q))
        )
      }

      if (tag) {
        results = results.filter(m =>
          Array.isArray(m.tags) && m.tags.some(t => t.toLowerCase() === tag)
        )
      }

      jsonResponse(res, 200, results.map(m => ({
        name: m.name,
        version: m.version,
        title: m.title,
        description: m.description,
        author: m.author,
        tags: m.tags || [],
        license: m.license,
        icon: m.icon,
      })))
      return
    }

    if (req.method === 'GET' && path.startsWith('/manifest/')) {
      const name = path.slice('/manifest/'.length)
      const manifest = _registry.get(name)
      if (!manifest) {
        jsonResponse(res, 404, { error: 'not found', name })
        return
      }
      jsonResponse(res, 200, manifest)
      return
    }

    if (req.method === 'POST' && path === '/manifest') {
      let body
      try {
        body = await readBody(req)
      } catch (err) {
        if (err.code !== 'INVALID_JSON') throw err
        jsonResponse(res, 400, { error: 'invalid manifest', errors: ['body must be valid JSON'] })
        return
      }
      if (!body) {
        jsonResponse(res, 400, { error: 'body required' })
        return
      }

      const validation = validateManifest(body)
      if (!validation.valid) {
        jsonResponse(res, 400, { error: 'invalid manifest', errors: validation.errors })
        return
      }

      const existing = _registry.get(body.name)
      if (existing) {
        if (body.version === existing.version) {
          jsonResponse(res, 409, { error: 'version already exists', name: body.name, version: body.version })
          return
        }
        if (!isVersionGreater(body.version, existing.version)) {
          jsonResponse(res, 409, {
            error: 'version must be greater than the stored version',
            name: body.name,
            version: body.version,
            stored: existing.version,
          })
          return
        }
      }

      const replaced = existing ? existing.version : null
      const next = new Map(_registry)
      next.set(body.name, body)
      try {
        saveRegistry(next)
      } catch (err) {
        console.error(`Failed to save registry to ${DATA_FILE}:`, err.message)
        jsonResponse(res, 500, { error: 'registry not saved', name: body.name, version: body.version })
        return
      }
      _registry = next
      console.log(`Published: ${body.name}@${body.version}${replaced ? ` (replaced ${replaced})` : ''}`)
      jsonResponse(res, 200, { ok: true, name: body.name, version: body.version, replaced })
      return
    }

    jsonResponse(res, 404, { error: 'not found', path })
  } catch (err) {
    console.error('Request error:', err)
    jsonResponse(res, 500, { error: 'internal error', message: err.message })
  }
})

try {
  loadRegistry()
} catch (err) {
  console.error(`${err.name}: ${err.message}`)
  process.exit(1)
}
server.listen(PORT, () => {
  console.log(`Marketplace registry running on http://localhost:${PORT}`)
  console.log(`  GET  /index           -- list all apps`)
  console.log(`  GET  /search?q=&tag=  -- search apps`)
  console.log(`  GET  /manifest/:name  -- get app manifest`)
  console.log(`  POST /manifest        -- publish app manifest`)
  console.log(`  GET  /health          -- liveness check`)
  console.log(`  Data file: ${DATA_FILE}`)
})