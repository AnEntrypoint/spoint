import { createWriteStream, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getProgressive } from '../static/ProgressiveBake.js'

const MAX_SIZE = 50 * 1024 * 1024
const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]) // 'glTF'

// Streaming multipart/form-data parser: scans each incoming chunk for the boundary against a small
// rolling tail buffer (never holds more than one boundary-length of look-back plus the current chunk),
// and streams the matched file part straight to a temp file on disk instead of buffering the whole
// (up to 50MB) request body in RAM. Non-file fields are still buffered in memory since they are
// expected to be tiny (form text fields), only the file part streams.
export function createUploadHandler(appRuntime, connections, playerManager) {
  const modelsDir = resolve(process.cwd(), 'data/models')
  if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true })

  return function handleUpload(req, res) {
    const ct = req.headers['content-type'] || ''
    const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/)
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null
    if (!boundary) { res.writeHead(400); res.end('no boundary'); return }

    const tmpName = randomUUID() + '.part'
    const tmpPath = resolve(modelsDir, tmpName)
    let finalPath = null
    let finished = false
    let size = 0
    let destroyed = false

    const parser = new StreamingMultipartParser(boundary)
    let writeStream = null
    let filename = null
    let magicChecked = false
    let magicOk = true
    let magicBuf = Buffer.alloc(0)

    function fail(status, msg) {
      if (finished) return
      finished = true
      destroyed = true
      try { if (writeStream) writeStream.destroy() } catch (_) {}
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch (_) {}
      try { res.writeHead(status); res.end(msg) } catch (_) {}
      req.destroy()
    }

    parser.onFileStart = (fname) => {
      filename = fname
      const ext = extname(filename || '').toLowerCase()
      if (ext !== '.glb' && ext !== '.gltf' && ext !== '.vrm') { fail(400, 'invalid type'); return }
      writeStream = createWriteStream(tmpPath)
      writeStream.on('error', e => { console.error('[upload] write error:', e.message); fail(500, 'error') })
    }
    parser.onFileData = (chunk) => {
      if (destroyed || !writeStream) return
      size += chunk.length
      if (size > MAX_SIZE) { fail(413, 'too large'); return }
      // magic-byte validation: buffer just the first ~16 bytes of the FILE part (not the whole file)
      // to check the actual bytes rather than trusting the client-declared filename extension.
      if (!magicChecked) {
        magicBuf = magicBuf.length ? Buffer.concat([magicBuf, chunk]) : chunk
        if (magicBuf.length >= 16 || parser.fileEnded) {
          magicChecked = true
          const ext = extname(filename || '').toLowerCase()
          if (ext === '.glb') {
            magicOk = magicBuf.length >= 4 && magicBuf.subarray(0, 4).equals(GLB_MAGIC)
          } else {
            // .gltf / .vrm-as-json: must start with valid-looking JSON (allow leading whitespace)
            const head = magicBuf.subarray(0, Math.min(magicBuf.length, 16)).toString('utf8').trimStart()
            magicOk = head.startsWith('{')
          }
          if (!magicOk) { fail(400, 'invalid file content'); return }
        }
      }
      if (!destroyed && writeStream && !writeStream.destroyed) writeStream.write(chunk)
    }
    parser.onFileEnd = () => {
      if (writeStream) writeStream.end()
    }
    parser.onError = (msg) => { fail(400, msg) }

    req.on('data', chunk => {
      if (destroyed) return
      try { parser.write(chunk) } catch (e) { fail(400, 'malformed multipart body') }
    })
    req.on('end', () => {
      if (destroyed) return
      if (!filename) { fail(400, 'no file'); return }
      if (!magicChecked) {
        // file smaller than the magic-check threshold; validate on whatever we buffered
        magicChecked = true
        const ext = extname(filename || '').toLowerCase()
        if (ext === '.glb') magicOk = magicBuf.length >= 4 && magicBuf.subarray(0, 4).equals(GLB_MAGIC)
        else { const head = magicBuf.toString('utf8').trimStart(); magicOk = head.startsWith('{') }
        if (!magicOk) { fail(400, 'invalid file content'); return }
      }
      const finalize = () => {
        if (finished) return
        finished = true
        try {
          const ext = extname(filename).toLowerCase()
          const name = randomUUID() + ext
          finalPath = resolve(modelsDir, name)
          renameSync(tmpPath, finalPath)
          try { getProgressive(finalPath) } catch (e) { console.error('[upload] bake kick failed:', e.message) }
          const url = '/data/models/' + name
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ url }))
        } catch (e) {
          console.error('[upload]', e.message)
          try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch (_) {}
          res.writeHead(500); res.end('error')
        }
      }
      if (writeStream && !writeStream.writableEnded) writeStream.end(finalize)
      else finalize()
    })
    req.on('error', () => { fail(500, 'error') })
  }
}

// Rolling boundary-scan multipart parser (busboy-style manual state machine). Consumes chunks
// incrementally: keeps only a small tail buffer (up to one boundary-length) across chunk boundaries
// so the boundary can be detected even when split across two `data` events, without ever holding the
// full request body in memory. Only tracks the first file-part (filename= present); everything else
// is treated as a discardable form field.
const STATE_HEADERS = 0
const STATE_FILE_DATA = 1
const STATE_SKIP_FIELD = 2
const STATE_DONE = 3

class StreamingMultipartParser {
  constructor(boundary) {
    this.delim = Buffer.from('--' + boundary)
    this.closeDelim = Buffer.from('--' + boundary + '--')
    this.state = STATE_HEADERS
    this.tail = Buffer.alloc(0)
    this.sawFile = false
    this.fileEnded = false
    this.onFileStart = null
    this.onFileData = null
    this.onFileEnd = null
    this.onError = null
  }

  write(chunk) {
    if (this.state === STATE_DONE) return
    let buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk
    // keep enough tail to re-detect a boundary split across chunks next time
    const keepTail = this.delim.length + 4

    while (true) {
      if (this.state === STATE_HEADERS) {
        const start = buf.indexOf(this.delim)
        if (start === -1) { this.tail = buf.subarray(Math.max(0, buf.length - keepTail)); return }
        let pos = start + this.delim.length
        if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) { this.state = STATE_DONE; this.tail = Buffer.alloc(0); return }
        if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2
        const headerEnd = buf.indexOf('\r\n\r\n', pos)
        if (headerEnd === -1) { this.tail = buf.subarray(start); return } // wait for more data
        const headerStr = buf.subarray(pos, headerEnd).toString('utf8')
        pos = headerEnd + 4
        const disp = headerStr.split('\r\n').find(l => l.toLowerCase().startsWith('content-disposition'))
        const fnMatch = disp && disp.match(/filename="([^"]*)"/)
        if (fnMatch && fnMatch[1] && !this.sawFile) {
          this.sawFile = true
          this.fileEnded = false
          this.state = STATE_FILE_DATA
          if (this.onFileStart) this.onFileStart(fnMatch[1])
        } else {
          this.state = STATE_SKIP_FIELD
        }
        buf = buf.subarray(pos)
        continue
      }
      if (this.state === STATE_FILE_DATA || this.state === STATE_SKIP_FIELD) {
        const boundaryPos = buf.indexOf(this.delim)
        if (boundaryPos === -1) {
          // emit everything except a safety tail (in case the boundary is split across chunks)
          const emitLen = Math.max(0, buf.length - keepTail)
          if (emitLen > 0) {
            if (this.state === STATE_FILE_DATA && this.onFileData) this.onFileData(buf.subarray(0, emitLen))
            buf = buf.subarray(emitLen)
          }
          this.tail = buf
          return
        }
        // data ends 2 bytes before the boundary (trailing \r\n)
        const dataEnd = Math.max(0, boundaryPos - 2)
        if (dataEnd > 0 && this.state === STATE_FILE_DATA && this.onFileData) this.onFileData(buf.subarray(0, dataEnd))
        if (this.state === STATE_FILE_DATA) { this.fileEnded = true; if (this.onFileEnd) this.onFileEnd() }
        buf = buf.subarray(boundaryPos)
        this.state = STATE_HEADERS
        continue
      }
      break
    }
  }
}
