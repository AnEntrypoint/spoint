import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, extname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_SIZE = 50 * 1024 * 1024

export function createUploadHandler(appRuntime, connections, playerManager) {
  const modelsDir = resolve(process.cwd(), 'data/models')
  if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true })

  return function handleUpload(req, res) {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_SIZE) { res.writeHead(413); res.end('too large'); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks)
        const ct = req.headers['content-type'] || ''
        const boundary = ct.split('boundary=')[1]
        if (!boundary) { res.writeHead(400); res.end('no boundary'); return }
        const parts = parsePart(body, boundary)
        const file = parts.find(p => p.filename)
        if (!file) { res.writeHead(400); res.end('no file'); return }
        const ext = extname(file.filename).toLowerCase()
        if (ext !== '.glb' && ext !== '.gltf') { res.writeHead(400); res.end('invalid type'); return }
        const name = randomUUID() + ext
        const fp = resolve(modelsDir, name)
        writeFileSync(fp, file.data)
        const url = '/data/models/' + name
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ url }))
      } catch (e) {
        console.error('[upload]', e.message)
        res.writeHead(500); res.end('error')
      }
    })
    req.on('error', () => { res.writeHead(500); res.end('error') })
  }
}

function parsePart(body, boundary) {
  const enc = new TextDecoder('utf-8', { fatal: false })
  const sep = Buffer.from('--' + boundary)
  const parts = []
  let pos = 0
  while (pos < body.length) {
    const start = body.indexOf(sep, pos)
    if (start === -1) break
    pos = start + sep.length
    if (body[pos] === 0x2d && body[pos+1] === 0x2d) break
    if (body[pos] === 0x0d) pos += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos)
    if (headerEnd === -1) break
    const headerStr = enc.decode(body.slice(pos, headerEnd))
    pos = headerEnd + 4
    const nextBound = body.indexOf(sep, pos)
    const dataEnd = nextBound === -1 ? body.length : nextBound - 2
    const data = body.slice(pos, dataEnd)
    const disp = headerStr.split('\r\n').find(l => l.toLowerCase().startsWith('content-disposition'))
    const fnMatch = disp?.match(/filename="([^"]+)"/)
    parts.push({ filename: fnMatch?.[1] || null, data })
    pos = nextBound === -1 ? body.length : nextBound
  }
  return parts
}
