// AgentAuthoringAPI -- HTTP authoring surface for agentic game-making (PRD row
// agentic-game-making-pipeline). Follows the ServerAPIRoutes.js/EditorHandlers.js shape: plain
// (req, res, appRuntime, ctx) handlers wired into ServerAPI.js's httpHandler, JSON in/out.
//
// This is the machine-facing counterpart to the human editor: an agent (or scripts/verify-app.mjs)
// can create an app from a template, rewrite an app's source, place/destroy entities in the LIVE
// world, inspect the live entity/app state, and persist the current world to apps/world/<name>.js --
// the same file format apps/world/*.js worlds already use (see e2e-ci-arena.js), so a saved world
// boots again via WORLD=<name> with zero extra machinery.
//
// Everything here is backend; no UI. Auth: if SPOINT_AGENT_TOKEN is set, requests must carry that
// exact value in the x-agent-token header (same fail-closed shape as the EDITOR_TOKEN gate);
// unset means open, matching the dev-server default of the editor routes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTemplateContent } from '../../bin/templates.js'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = resolve(__dirname, '..', '..')

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const APP_FILE_RE = /^[A-Za-z0-9._-]{1,64}\.js$/

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch (e) { reject(new Error('invalid JSON body: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

// Serialize one live entity back into the world-definition shape ({ id, app, position, ... }) --
// the same field set apps/world/*.js entities use, so round-tripping through save-world is
// lossless for everything the world loader itself consumes.
function encodeWorldEntity(id, e) {
  const out = { id, app: e._appName || undefined }
  if (e.model) out.model = e.model
  out.position = [...e.position]
  const rot = Array.isArray(e.rotation)
    ? [...e.rotation]
    : [e.rotation?.x || 0, e.rotation?.y || 0, e.rotation?.z || 0, e.rotation?.w ?? 1]
  if (rot.some((v, i) => (i === 3 ? v !== 1 : v !== 0))) out.rotation = rot
  if (Array.isArray(e.scale) && e.scale.some(v => v !== 1)) out.scale = [...e.scale]
  if (e.config && typeof e.config === 'object' && Object.keys(e.config).length) out.config = e.config
  return out
}

export function createAgentAuthoringHandler() {
  return async function handleAgentRoute(req, res, appRuntime, ctx) {
    const token = process.env.SPOINT_AGENT_TOKEN
    if (token && req.headers['x-agent-token'] !== token) {
      json(res, 403, { ok: false, error: 'missing or wrong x-agent-token (SPOINT_AGENT_TOKEN is set)' })
      return
    }
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    try {
      // -- introspection -------------------------------------------------------------
      if (req.method === 'GET' && path === '/agent/apps') {
        json(res, 200, { ok: true, apps: Array.from(appRuntime._appDefs.keys()).sort() })
        return
      }
      if (req.method === 'GET' && path === '/agent/entities') {
        const out = []
        for (const [id, e] of appRuntime.entities) out.push(encodeWorldEntity(id, e))
        json(res, 200, { ok: true, count: out.length, entities: out })
        return
      }

      const body = req.method === 'POST' ? await readBody(req) : {}

      // -- app creation / modification -----------------------------------------------
      if (req.method === 'POST' && path === '/agent/create-app') {
        const name = body.name
        const template = body.template || 'simple'
        if (typeof name !== 'string' || !APP_NAME_RE.test(name)) {
          json(res, 400, { ok: false, error: `invalid app name '${name}' (need ${APP_NAME_RE})` }); return
        }
        const appDir = join(SDK_ROOT, 'apps', name)
        if (existsSync(appDir)) { json(res, 409, { ok: false, error: `app '${name}' already exists` }); return }
        let content
        try { content = getTemplateContent(template) } catch { content = null }
        if (content == null) {
          json(res, 400, { ok: false, error: `unknown template '${template}' (simple, physics, interactive, spawner, fsm-game)` }); return
        }
        mkdirSync(appDir, { recursive: true })
        const file = join(appDir, 'index.js')
        writeFileSync(file, content)
        console.log(`[agent-api] created app '${name}' from template '${template}' -> ${file}`)
        json(res, 200, { ok: true, name, template, file })
        return
      }
      if (req.method === 'POST' && path === '/agent/write-app') {
        const { appName, file = 'index.js', source } = body
        if (typeof appName !== 'string' || !APP_NAME_RE.test(appName)) { json(res, 400, { ok: false, error: 'invalid appName' }); return }
        if (!APP_FILE_RE.test(file) || file.includes('..')) { json(res, 400, { ok: false, error: `invalid file '${file}'` }); return }
        if (typeof source !== 'string' || !source.trim()) { json(res, 400, { ok: false, error: 'source must be a non-empty string' }); return }
        const appDir = join(SDK_ROOT, 'apps', appName)
        if (!existsSync(appDir)) { json(res, 404, { ok: false, error: `app '${appName}' does not exist` }); return }
        const target = join(appDir, file)
        writeFileSync(target, source)
        console.log(`[agent-api] wrote apps/${appName}/${file} (${source.length} bytes)`)
        json(res, 200, { ok: true, appName, file, bytes: source.length })
        return
      }
      if (req.method === 'GET' && path === '/agent/read-app') {
        const appName = url.searchParams.get('app')
        const file = url.searchParams.get('file') || 'index.js'
        if (typeof appName !== 'string' || !APP_NAME_RE.test(appName) || !APP_FILE_RE.test(file)) { json(res, 400, { ok: false, error: 'invalid app/file' }); return }
        const target = join(SDK_ROOT, 'apps', appName, file)
        if (!existsSync(target)) { json(res, 404, { ok: false, error: 'not found' }); return }
        json(res, 200, { ok: true, appName, file, source: readFileSync(target, 'utf8') })
        return
      }

      // -- live world mutation --------------------------------------------------------
      if (req.method === 'POST' && path === '/agent/place-entity') {
        const { app, position, config, id, model, scale } = body
        if (typeof app !== 'string' || !appRuntime._appDefs.has(app) && app !== 'placed-model') {
          json(res, 400, { ok: false, error: `unknown app '${app}' (not registered)` }); return
        }
        const eid = (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !appRuntime.entities.has(id))
          ? id
          : app + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const pos = Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)
          ? [...position] : [0, 1, 0]
        const cfg = { ...(config || {}), ...(model ? { model } : {}), ...(Array.isArray(scale) ? { scale } : {}) }
        appRuntime.spawnEntity(eid, { app, position: pos, config: cfg })
        console.log(`[agent-api] placed entity ${eid} (app=${app}) at ${JSON.stringify(pos)}`)
        json(res, 200, { ok: true, entityId: eid })
        return
      }
      if (req.method === 'POST' && path === '/agent/destroy-entity') {
        const { entityId } = body
        if (typeof entityId !== 'string' || !appRuntime.entities.has(entityId)) {
          json(res, 404, { ok: false, error: `no such entity '${entityId}'` }); return
        }
        appRuntime.destroyEntity(entityId)
        json(res, 200, { ok: true, entityId })
        return
      }

      // -- persistence -----------------------------------------------------------------
      if (req.method === 'POST' && path === '/agent/save-world') {
        const name = body.worldName
        if (typeof name !== 'string' || !APP_NAME_RE.test(name)) { json(res, 400, { ok: false, error: `invalid worldName '${name}'` }); return }
        const entities = []
        for (const [id, e] of appRuntime.entities) entities.push(encodeWorldEntity(id, e))
        const def = {
          port: ctx?.port || 3001,
          tickRate: ctx?.tickRate || 60,
          gravity: ctx?.currentWorldDef?.gravity || [0, -9.81, 0],
          spawnPoint: ctx?.currentWorldDef?.spawnPoint || [0, 5, 0],
          entities,
        }
        const src = '// Saved by AgentAuthoringAPI /agent/save-world at ' + new Date().toISOString() +
          '\nexport default ' + JSON.stringify(def, null, 2) + '\n'
        const worldDir = join(SDK_ROOT, 'apps', 'world')
        mkdirSync(worldDir, { recursive: true })
        const file = join(worldDir, name + '.js')
        writeFileSync(file, src)
        console.log(`[agent-api] saved world '${name}' (${entities.length} entities) -> ${file}`)
        json(res, 200, { ok: true, worldName: name, entityCount: entities.length, file })
        return
      }

      json(res, 404, { ok: false, error: `unknown agent route ${req.method} ${path}` })
    } catch (e) {
      console.error('[agent-api] error:', e?.stack || e)
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message || e) })
    }
  }
}
