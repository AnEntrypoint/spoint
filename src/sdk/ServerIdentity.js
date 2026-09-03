// Server identity: makes "WHICH checkout/process is answering this port?" a one-glance fact instead
// of a silent trap. Motivated by two live-witnessed incidents where a long-lived server on a default
// port served a DIFFERENT checkout's files than the one being edited, passing 200-status smoke checks
// while byte-diverging from the tree under edit (stale-server-serves-wrong-checkout-trap).
// Consumed by: boot() banner (src/sdk/server.js) and StaticHandler's /__identity JSON route.
import { execFileSync } from 'node:child_process'
import { realpathSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let _identity = null

function _pkgInfo(sdkRoot, name) {
  try {
    const real = realpathSync(join(sdkRoot, 'node_modules', name))
    const version = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')).version
    return { realpath: real, version }
  } catch (e) { return { error: e.message } }
}

export function getServerIdentity() {
  if (_identity) return _identity
  const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
  let headSha = null
  try { headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: sdkRoot, encoding: 'utf8', timeout: 5000 }).trim() } catch (_) {}
  _identity = {
    pid: process.pid,
    cwd: process.cwd(),
    sdkRoot,
    headSha,
    node: process.version,
    bootedAt: new Date().toISOString(),
    mapspinner: _pkgInfo(sdkRoot, 'mapspinner'),
    streamingGltf: _pkgInfo(sdkRoot, 'streaming-gltf'),
  }
  return _identity
}

export function logServerIdentity() {
  const id = getServerIdentity()
  console.log(`[identity] pid=${id.pid} sha=${id.headSha || '?'} root=${id.sdkRoot} cwd=${id.cwd}`)
  console.log(`[identity] mapspinner@${id.mapspinner.version || '?'} -> ${id.mapspinner.realpath || id.mapspinner.error}`)
  console.log(`[identity] streaming-gltf@${id.streamingGltf.version || '?'} -> ${id.streamingGltf.realpath || id.streamingGltf.error}`)
  console.log(`[identity] GET /__identity returns this as JSON`)
}
