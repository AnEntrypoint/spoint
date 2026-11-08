import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createNostrAuthServer } = await import(pathToFileURL(path.join(root, 'src/sdk/NostrAuthServer.js')).href)

const CONTENT_MISMATCH = 'signed event content does not match challenge'
const OTHER_CONTENT = 'some other content the peer chose to sign'
const sk = generateSecretKey()
const pubkey = getPublicKey(sk)
let failures = 0

function check(name, ok, detail) {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} ${detail}`)
  if (!ok) failures++
}

function signed(content, createdAt) {
  return finalizeEvent({ kind: 27235, created_at: createdAt, tags: [], content }, sk)
}

async function respond({ signedOver, claimedContent, sendContent }) {
  const server = createNostrAuthServer({ enableChallenge: true, challengeTimeoutMs: 60000 })
  const transport = { close() {} }
  const challenge = await server.challengeConnection(transport)
  const event = signed(signedOver, Math.floor(Date.now() / 1000))
  const payload = { pubkey, sig: event.sig, id: event.id, created_at: event.created_at, kind: event.kind, tags: event.tags }
  if (sendContent) payload.content = claimedContent === undefined ? challenge : claimedContent
  const result = await server.verifyResponse(transport, payload)
  return { challenge, result }
}

{
  const { challenge, result } = await respond({ signedOver: OTHER_CONTENT, claimedContent: OTHER_CONTENT, sendContent: true })
  check('A-other-content-refused', result.ok === false && result.error === CONTENT_MISMATCH,
    `challenge=${challenge.slice(0, 8)}… ok=${result.ok} error=${JSON.stringify(result.error)}`)
}

{
  const server = createNostrAuthServer({ enableChallenge: true, challengeTimeoutMs: 60000 })
  const transport = { close() {} }
  const challenge = await server.challengeConnection(transport)
  const event = signed(challenge, Math.floor(Date.now() / 1000))
  const result = await server.verifyResponse(transport, { pubkey, sig: event.sig, id: event.id, created_at: event.created_at, kind: event.kind, tags: event.tags, content: challenge })
  check('C-challenge-signed-challenge-sent-accepted', result.ok === true && result.pubkey === pubkey,
    `ok=${result.ok} pubkeyMatches=${result.pubkey === pubkey}`)
}

{
  const server = createNostrAuthServer({ enableChallenge: true, challengeTimeoutMs: 60000 })
  const transport = { close() {} }
  const challenge = await server.challengeConnection(transport)
  const event = signed(challenge, Math.floor(Date.now() / 1000))
  const result = await server.verifyResponse(transport, { pubkey, sig: event.sig, id: event.id, created_at: event.created_at, kind: event.kind, tags: event.tags })
  check('D-challenge-signed-no-content-field-accepted', result.ok === true && result.pubkey === pubkey,
    `ok=${result.ok} pubkeyMatches=${result.pubkey === pubkey}`)
}

{
  const { result } = await respond({ signedOver: OTHER_CONTENT, claimedContent: undefined, sendContent: true })
  check('E-other-content-with-challenge-claimed-refused', result.ok === false && result.error === 'invalid signature',
    `ok=${result.ok} error=${JSON.stringify(result.error)}`)
}

const verdict = failures === 0 ? 'PASS' : 'FAIL'
console.log(`RESULT: ${verdict} (${failures} failing checks)`)
process.exitCode = failures === 0 ? 0 : 1
