#!/usr/bin/env node
/**
 * marketplace-registry.js -- Minimal spoint app marketplace registry server.
 *
 * This is the FIRST SLICE of plugin-marketplace-registry-server: a simple HTTP
 * server that accepts app manifest uploads, indexes them, and serves search/browse
 * endpoints. Uses a flat JSON file for persistence.
 *
 * Usage:
 *   PORT=3100 node bin/marketplace-registry.js
 *   PORT=3100 DATA_FILE=./registry-data.json node bin/marketplace-registry.js
 *
 * Endpoints:
 *   GET  /index                    -- list all manifests (name, version, title, description, tags)
 *   GET  /manifest/:name           -- get a single manifest
 *   POST /manifest                 -- upload/publish a manifest (body: JSON manifest object)
 *   GET  /search?q=...&tag=...     -- search manifests by name/description/title (q) and tag (tag)
 *   GET  /health                   -- liveness check
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { validateManifest } from '../src/sdk/AppManifest.js'

const PORT = parseInt(process.env.PORT || '3100', 10)
const DATA_FILE = process.env.DATA_FILE || './registry-data.json'

// ---------------------------------------------------------------------------
// In-memory store, loaded from disk on boot
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} name -> manifest */
let _registry = new Map()

function loadRegistry() {
  if (existsSync(DATA_FILE)) {
    try {
      const raw = readFileSync(DATA_FILE, 'utf-8')
      const entries = JSON.parse(raw)
      if (Array.isArray(entries)) {
        _registry = new Map(entries.map(e => [e.name, e]))
        console.log(`Loaded ${_registry.size} entries from ${DATA_FILE}`)
      }
    } catch (err) {
      console.error(`Failed to load registry from ${DATA_FILE}:`, err.message)
    }
  }
}

function saveRegistry() {
  try {
    const entries = [..._registry.values()]
    writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2), 'utf-8')
  } catch (err) {
    console.error(`Failed to save registry to ${DATA_FILE}:`, err.message)
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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
      } catch (err) {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  // CORS preflight
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
    // GET /health
    if (req.method === 'GET' && path === '/health') {
      jsonResponse(res, 200, { ok: true, count: _registry.size })
      return
    }

    // GET /index
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

    // GET /search?q=...&tag=...
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

    // GET /manifest/:name
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

    // POST /manifest
    if (req.method === 'POST' && path === '/manifest') {
      const body = await readBody(req)
      if (!body) {
        jsonResponse(res, 400, { error: 'body required' })
        return
      }

      const validation = validateManifest(body)
      if (!validation.valid) {
        jsonResponse(res, 400, { error: 'invalid manifest', errors: validation.errors })
        return
      }

      // Check for existing entry
      const existing = _registry.get(body.name)
      if (existing) {
        // Version must be newer
        if (body.version === existing.version) {
          jsonResponse(res, 409, { error: 'version already exists', name: body.name, version: body.version })
          return
        }
      }

      _registry.set(body.name, body)
      saveRegistry()
      console.log(`Published: ${body.name}@${body.version}`)
      jsonResponse(res, 200, { ok: true, name: body.name, version: body.version })
      return
    }

    // 404
    jsonResponse(res, 404, { error: 'not found', path })
  } catch (err) {
    console.error('Request error:', err)
    jsonResponse(res, 500, { error: 'internal error', message: err.message })
  }
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadRegistry()
server.listen(PORT, () => {
  console.log(`Marketplace registry running on http://localhost:${PORT}`)
  console.log(`  GET  /index           -- list all apps`)
  console.log(`  GET  /search?q=&tag=  -- search apps`)
  console.log(`  GET  /manifest/:name  -- get app manifest`)
  console.log(`  POST /manifest        -- publish app manifest`)
  console.log(`  GET  /health          -- liveness check`)
  console.log(`  Data file: ${DATA_FILE}`)
})