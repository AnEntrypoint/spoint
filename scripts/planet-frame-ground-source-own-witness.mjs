import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const sampler = { radius: 63600, hashVersion: 2, heightAt: () => 10 }
const frameOf = () => createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.001 })
const attempt = (fn) => { try { return { value: fn() } } catch (error) { return { error } } }

const base = frameOf()
const derived = Object.create(base)
const installed = attempt(() => derived.registerGroundSource('placement-only', (x, z, yGuess) => (yGuess ?? 0)))
check('a frame linked to the owner through its prototype cannot install a ground source', installed.error instanceof TypeError, installed.error ? installed.error.message.slice(0, 90) : `returned ${String(installed.value)}`)
check('the refused install leaves the owner ground sources unchanged', base.groundSource === 'cpu-solve' && JSON.stringify(base.groundSources) === '["cpu-solve"]', `groundSource=${base.groundSource} groundSources=${JSON.stringify(base.groundSources)}`)

const assigned = attempt(() => { derived.groundHeightLocal = (x, z, yGuess) => (yGuess ?? 1) })
check('assigning groundHeightLocal through a prototype-linked frame is refused', assigned.error instanceof TypeError, assigned.error ? assigned.error.message.slice(0, 90) : 'assignment went through')
check('the refused assignment leaves the owner ground sources unchanged', base.groundSource === 'cpu-solve' && JSON.stringify(base.groundSources) === '["cpu-solve"]', `groundSource=${base.groundSource} groundSources=${JSON.stringify(base.groundSources)}`)

const detached = attempt(() => { const { registerGroundSource } = base; return registerGroundSource('detached', (x, z, yGuess) => (yGuess ?? 0)) })
check('calling registerGroundSource without its frame as receiver is refused', detached.error instanceof TypeError, detached.error ? detached.error.message.slice(0, 90) : `returned ${String(detached.value)}`)

const owned = attempt(() => base.registerGroundSource('owner-install', (x, z, yGuess) => (yGuess ?? 0)))
check('the owner frame still installs its own ground source', owned.value === 'owner-install' && base.groundSource === 'owner-install', `returned ${String(owned.value ?? owned.error?.message)} groundSource=${base.groundSource}`)

const reads = base.groundSources.join(',') === 'cpu-solve,owner-install' && derived.groundSource === 'owner-install'
check('a prototype-linked frame still reads the owner state through the prototype', reads, `derived.groundSource=${derived.groundSource}`)

const shadow = frameOf()
const placement = Object.create(shadow)
Object.defineProperty(placement, 'groundHeightLocal', { value: (x, z) => 7, writable: true, configurable: true })
check('an own groundHeightLocal on a derived frame shadows the owner without touching it', placement.groundHeightLocal(0, 0) === 7 && shadow.groundSource === 'cpu-solve' && JSON.stringify(shadow.groundSources) === '["cpu-solve"]', `shadow=${shadow.groundSource}`)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS a prototype-linked PlanetFrame cannot install or assign a ground source on the frame that owns them, and the owner and its own shadow stay unchanged')
  await exitAfterQuiesce(0)
}
