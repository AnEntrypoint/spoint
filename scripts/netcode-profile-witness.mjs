#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deepStrictEqual } from 'node:assert/strict'

const srcArg = process.argv.slice(2).find(arg => arg.startsWith('--src='))
const SRC = resolve(srcArg ? srcArg.slice('--src='.length) : join(dirname(fileURLToPath(import.meta.url)), '..', 'src'))
const MODULE_FILE = join(SRC, 'netcode', 'NetcodeProfile.js')
const WITNESS_FILE = fileURLToPath(import.meta.url)

const sha16 = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
const show = value => JSON.stringify(value)
const same = (got, want) => {
  try { deepStrictEqual(got, want); return true } catch { return false }
}
const outcome = fn => {
  try { return fn() } catch (error) { return { threw: error instanceof Error ? error.message : String(error) } }
}
const thrownMessage = fn => {
  try { fn() } catch (error) { return error instanceof Error ? error.message : String(error) }
  return null
}
const thrownError = fn => {
  try { fn(); return null } catch (error) { return error }
}

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} -- ${detail}`)
}

const moduleHash = (() => { try { return sha16(MODULE_FILE) } catch { return 'missing' } })()
console.log(`[netcode-profile-witness] module=${MODULE_FILE} module_sha256_16=${moduleHash} witness_sha256_16=${sha16(WITNESS_FILE)}`)

let loaded = null
try {
  const [module, rollbackLoop, lockstepLoop, worldResolve] = await Promise.all([
    import(pathToFileURL(MODULE_FILE).href),
    import(pathToFileURL(join(SRC, 'netcode', 'RollbackGameLoop.js')).href),
    import(pathToFileURL(join(SRC, 'netcode', 'LockstepGameLoop.js')).href),
    import(pathToFileURL(join(SRC, 'shared', 'worldResolve.js')).href),
  ])
  loaded = { module, worldResolve, rollbackDefaults: rollbackLoop.ROLLBACK_DEFAULTS, lockstepDefaults: lockstepLoop.LOCKSTEP_DEFAULTS }
} catch (error) {
  console.log(`[FAIL] module loads -- ${error?.message ?? error}`)
  console.log('RESULT: FAIL -- the module did not load, so no check ran')
  process.exitCode = 1
}

if (loaded) {
  try {
    const { resolveNetcodeProfile, NETCODE_PROFILES, PEER_SIMULATED_PROFILES, DEFAULT_MIN_PEERS } = loaded.module
    const { rollbackDefaults, lockstepDefaults } = loaded

    check('NETCODE_PROFILES is the frozen list authoritative, rollback, lockstep',
      same([...NETCODE_PROFILES], ['authoritative', 'rollback', 'lockstep']) && Object.isFrozen(NETCODE_PROFILES),
      `got ${show([...NETCODE_PROFILES])} frozen=${Object.isFrozen(NETCODE_PROFILES)}`)
    check('PEER_SIMULATED_PROFILES is a Set of exactly rollback and lockstep',
      PEER_SIMULATED_PROFILES instanceof Set && same([...PEER_SIMULATED_PROFILES].sort(), ['lockstep', 'rollback']),
      `got ${show([...PEER_SIMULATED_PROFILES])}`)
    check('DEFAULT_MIN_PEERS is 2', DEFAULT_MIN_PEERS === 2, `got ${show(DEFAULT_MIN_PEERS)}`)

    const bare = { name: 'authoritative', options: {}, peerSimulated: false, minPeers: 2 }
    const fromUndefined = outcome(() => resolveNetcodeProfile(undefined))
    const fromNull = outcome(() => resolveNetcodeProfile(null))
    const fromEmpty = outcome(() => resolveNetcodeProfile({}))
    check('no world def resolves to authoritative with no options', same(fromUndefined, bare), `got ${show(fromUndefined)}`)
    check('null world def resolves the same as no world def', same(fromNull, bare), `got ${show(fromNull)}`)
    check('world def without a netcode block resolves the same as no world def', same(fromEmpty, bare), `got ${show(fromEmpty)}`)
    const fromNullNetcode = outcome(() => resolveNetcodeProfile({ netcode: null }))
    check('a null netcode block resolves the same as no netcode block', same(fromNullNetcode, bare), `got ${show(fromNullNetcode)}`)

    const rollbackDefault = outcome(() => resolveNetcodeProfile({ netcode: { profile: 'rollback' } }))
    check('rollback with no overrides takes the rollback module defaults',
      same(rollbackDefault, { name: 'rollback', options: { ...rollbackDefaults }, peerSimulated: true, minPeers: 2 }),
      `got ${show(rollbackDefault)} module_defaults=${show(rollbackDefaults)}`)

    const lockstepOverride = outcome(() => resolveNetcodeProfile({ netcode: { profile: 'lockstep', lockstep: { stallTicks: 900 }, peers: 4 } }))
    check('lockstep overrides merge over the lockstep module defaults and peers is read',
      same(lockstepOverride, { name: 'lockstep', options: { ...lockstepDefaults, stallTicks: 900 }, peerSimulated: true, minPeers: 4 }),
      `got ${show(lockstepOverride)} module_defaults=${show(lockstepDefaults)}`)

    const zeros = outcome(() => resolveNetcodeProfile({ netcode: { profile: 'rollback', rollback: { inputDelayTicks: 0 }, peers: 0 } }))
    check('zero is accepted as a non-negative integer', zeros.options?.inputDelayTicks === 0 && zeros.minPeers === 0, `got ${show(zeros)}`)

    const overridden = outcome(() => resolveNetcodeProfile({ netcode: { profile: 'rollback', rollback: { maxRollbackTicks: 5 } } }))
    const nextDefault = outcome(() => resolveNetcodeProfile({ netcode: { profile: 'rollback' } }))
    check('an override applies to its own resolve and does not leak into the next',
      overridden.options?.maxRollbackTicks === 5 && nextDefault.options?.maxRollbackTicks === rollbackDefaults.maxRollbackTicks,
      `overridden=${overridden.options?.maxRollbackTicks} next=${nextDefault.options?.maxRollbackTicks} module_default=${rollbackDefaults.maxRollbackTicks}`)

    const rejections = [
      ['an unknown profile name throws and lists the valid names',
        { netcode: { profile: 'bogus' } },
        "[netcode] unknown netcode.profile 'bogus' (expected one of authoritative, rollback, lockstep)"],
      ['a negative rollback tick count throws',
        { netcode: { profile: 'rollback', rollback: { maxRollbackTicks: -1 } } },
        '[netcode] rollback.maxRollbackTicks must be a non-negative integer, got -1'],
      ['a fractional lockstep tick count throws',
        { netcode: { profile: 'lockstep', lockstep: { stallTicks: 1.5 } } },
        '[netcode] lockstep.stallTicks must be a non-negative integer, got 1.5'],
      ['a numeric-string lockstep tick count throws',
        { netcode: { profile: 'lockstep', lockstep: { stallTicks: '600' } } },
        '[netcode] lockstep.stallTicks must be a non-negative integer, got "600"'],
      ['a NaN rollback tick count throws',
        { netcode: { profile: 'rollback', rollback: { checksumIntervalTicks: NaN } } },
        '[netcode] rollback.checksumIntervalTicks must be a non-negative integer, got null'],
      ['a negative peer count throws',
        { netcode: { profile: 'authoritative', peers: -2 } },
        '[netcode] netcode.peers must be a non-negative integer, got -2'],
      ['a fractional peer count throws',
        { netcode: { profile: 'rollback', peers: 2.5 } },
        '[netcode] netcode.peers must be a non-negative integer, got 2.5'],
      ['a string netcode throws instead of silently resolving the default profile',
        { netcode: 'rollback' },
        '[netcode] netcode must be an object declaring profile and per-profile options, got "rollback"'],
      ['a numeric netcode throws',
        { netcode: 5 },
        '[netcode] netcode must be an object declaring profile and per-profile options, got 5'],
      ['an array netcode throws',
        { netcode: ['rollback'] },
        '[netcode] netcode must be an object declaring profile and per-profile options, got ["rollback"]'],
      ['a boolean netcode throws',
        { netcode: true },
        '[netcode] netcode must be an object declaring profile and per-profile options, got true'],
      ['a symbol netcode throws and still names the value',
        { netcode: Symbol('rollback') },
        '[netcode] netcode must be an object declaring profile and per-profile options, got Symbol(rollback)'],
    ]
    for (const [name, worldDef, want] of rejections) {
      const got = thrownMessage(() => resolveNetcodeProfile(worldDef))
      check(name, got === want, `got ${show(got)}`)
    }

    const { assertWorld, WorldResolveError, WORLD_FIELD_INVALID } = loaded.worldResolve
    const REPO = dirname(SRC)
    for (const [label, worldDef] of [
      ['a string netcode', { name: 'w4', netcode: 'rollback' }],
      ['a numeric netcode', { name: 'w4', netcode: 5 }],
      ['an array netcode', { name: 'w4', netcode: ['rollback'] }],
      ['a boolean netcode', { name: 'w4', netcode: true }],
    ]) {
      const error = thrownError(() => assertWorld(worldDef, 'w4'))
      check(`assertWorld rejects ${label} at the netcode path instead of accepting it`,
        error instanceof WorldResolveError && error.path === 'netcode' && error.code === WORLD_FIELD_INVALID,
        error ? `got ${show({ name: error.name, path: error.path, code: error.code })} ${show(error.message)}` : 'got ACCEPTED')
    }
    const accepted = thrownError(() => assertWorld({ name: 'w5', netcode: { profile: 'rollback' } }, 'w5'))
    check('assertWorld accepts a declared rollback netcode object', accepted === null, accepted ? `got ${show(accepted.message)}` : 'got ACCEPTED')
    const acceptedNull = thrownError(() => assertWorld({ name: 'w7', netcode: null }, 'w7'))
    check('assertWorld accepts netcode null as an absent block', acceptedNull === null, acceptedNull ? `got ${show(acceptedNull.message)}` : 'got ACCEPTED')
    const declaredWorld = assertWorld({ name: 'w5', netcode: { profile: 'rollback' } }, 'w5')
    check('the accepted world resolves the profile it declared rather than the default',
      resolveNetcodeProfile(declaredWorld).name === 'rollback', `got ${show(resolveNetcodeProfile(declaredWorld).name)}`)
    for (const [name, profile] of [['rollback-duel', 'rollback'], ['lockstep-rts', 'lockstep']]) {
      const mod = await import(pathToFileURL(join(REPO, 'apps', 'world', `${name}.js`)).href)
      const world = assertWorld(mod.default, name)
      const got = resolveNetcodeProfile(world).name
      check(`shipped world ${name} still parses and still resolves ${profile}`, got === profile, `got ${show(got)}`)
    }
  } catch (error) {
    failed++
    console.log(`[FAIL] the checks aborted -- ${error?.message ?? error}`)
  }

  const total = passed + failed
  if (failed === 0) {
    console.log(`RESULT: PASS -- ${passed} of ${total} check(s) held over ${MODULE_FILE}`)
    process.exitCode = 0
  } else {
    console.log(`RESULT: FAIL -- ${failed} of ${total} check(s) failed over ${MODULE_FILE}`)
    process.exitCode = 1
  }
}
