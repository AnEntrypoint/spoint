#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { RoomDirectory } from '../src/sdk/RoomDirectory.js'
import { assertNodeModulesLinked } from '../src/sdk/server.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (chunk) => { buf += chunk })
    req.on('end', () => { try { resolve(JSON.parse(buf)) } catch (_) { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const requestFn = url.startsWith('https') ? httpsRequest : httpRequest
    const req = requestFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function httpDelete(url) {
  return new Promise((resolve, reject) => {
    const requestFn = url.startsWith('https') ? httpsRequest : httpRequest
    const req = requestFn(url, { method: 'DELETE' }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) } catch (e) { resolve({ status: res.statusCode, body: null }) } })
    })
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  assertNodeModulesLinked(SDK_ROOT)
  const PROJECT = process.cwd()
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3400'
  const workerHost = process.env.WORKER_HOST || '127.0.0.1'
  const workerCommandPort = parseInt(process.env.WORKER_COMMAND_PORT || '0', 10)
  const portRangeMin = parseInt(process.env.ROOM_PORT_MIN || '19100', 10)
  const portRangeMax = parseInt(process.env.ROOM_PORT_MAX || '19199', 10)

  const directory = new RoomDirectory({
    sdkRoot: SDK_ROOT,
    projectRoot: existsSync(join(PROJECT, 'apps')) ? PROJECT : SDK_ROOT,
    portRange: [portRangeMin, portRangeMax],
  })

  const commandServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/rooms') {
        const body = await readJsonBody(req)
        if (!body || !body.roomId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'roomId required' })); return }
        try {
          const handle = await directory.createRoom(body.roomId, body.worldName || 'tps-game', body.opts || {})
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ roomId: body.roomId, port: handle.port, worldName: handle.worldName }))
        } catch (e) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message || String(e) }))
        }
        return
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/rooms/')) {
        const roomId = decodeURIComponent(url.pathname.slice('/rooms/'.length))
        const stopped = await directory.stopRoom(roomId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ roomId, stopped }))
        return
      }
      if (url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ rooms: directory.getStatus() }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ shuttingDown: true }))
        await directory.stopAll()
        process.exit(0)
        return
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e?.message || String(e) }))
    }
  })

  const { port: boundCommandPort } = await new Promise((resolve, reject) => {
    commandServer.once('error', reject)
    commandServer.listen(workerCommandPort, () => resolve({ port: commandServer.address().port }))
  })

  console.log(`[room-worker] command server listening on http://${workerHost}:${boundCommandPort}`)

  const registration = await httpPostJson(`${orchestratorUrl}/workers/register`, {
    host: workerHost,
    portRange: [portRangeMin, portRangeMax],
    commandPort: boundCommandPort,
  })

  if (registration.status !== 201) {
    console.error(`[room-worker] registration failed: ${JSON.stringify(registration.body)}`)
    process.exit(1)
  }

  const workerIndex = registration.body.workerIndex
  console.log(`[room-worker] registered as worker ${workerIndex} with orchestrator at ${orchestratorUrl}`)

  const shutdown = async (signal) => {
    console.log(`[room-worker] received ${signal}, deregistering and shutting down...`)
    try { await httpDelete(`${orchestratorUrl}/workers/${workerIndex}`) } catch (_) {}
    await directory.stopAll()
    await new Promise((resolve) => commandServer.close(() => resolve()))
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[room-worker] FATAL:', err)
  process.exit(1)
})
