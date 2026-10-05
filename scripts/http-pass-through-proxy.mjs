#!/usr/bin/env node
import http from 'node:http'
import { request as httpRequest } from 'node:http'

const PORT = Number(process.argv[2] || 3091)
const TARGET = process.argv[3] || 'http://127.0.0.1:3000'
const target = new URL(TARGET)

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])

function copyHeaders(src) {
  const out = {}
  for (const [k, v] of Object.entries(src)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v
  out.host = target.host
  return out
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const upstream = httpRequest(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: copyHeaders(req.headers), agent: false },
      up => {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
      }
    )
    upstream.on('error', e => {
      console.error(`[pass-through] ${req.method} ${req.url} -> ${e.message}`)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('proxy error: ' + e.message)
    })
    for (const c of chunks) upstream.write(c)
    upstream.end()
  })
})

server.on('upgrade', (req, socket, head) => {
  const upstream = httpRequest({ protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: copyHeaders(req.headers), agent: false })
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}\r\n`)
    for (const [k, v] of Object.entries(upRes.headers)) socket.write(`${k}: ${v}\r\n`)
    socket.write('\r\n')
    if (head?.length) upSocket.write(head)
    if (upHead?.length) socket.write(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  upstream.on('error', e => {
    console.error(`[pass-through] upgrade ${req.url} -> ${e.message}`)
    socket.destroy()
  })
  upstream.end()
})

server.listen(PORT, () => console.log(`[pass-through] http://127.0.0.1:${PORT} -> ${TARGET}`))
