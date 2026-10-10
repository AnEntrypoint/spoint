import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] ?? join(root, 'src/effects/DamageEffects.js')
const API = ['triggerDamage', 'update', 'getConfig', 'setConfig', 'getActiveShake', 'setScreenShake', 'setSound', 'screenShakeEnabled', 'soundEnabled']
const origin = { x: 0, y: 0, z: 0 }

const checks = []
const expect = (label, ok, detail = '') => {
	checks.push(Boolean(ok))
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

const configIs = (cfg, want) => {
	const keys = Object.keys(want)
	return Object.keys(cfg).length === keys.length && keys.every(key => cfg[key] === want[key])
}

const noThrow = fn => {
	try {
		fn()
		return true
	} catch (_) {
		return false
	}
}

const fresh = () => ({ position: { x: 0, y: 0, z: 0 } })

const exercise = async () => {
	console.log(`run ${new Date().toISOString()} target ${target}`)
	expect('no window or document global in this process', typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined')

	const { createDamageEffects } = await import(pathToFileURL(target).href)
	expect('module exports createDamageEffects as a function', typeof createDamageEffects === 'function')

	const realNow = Date.now
	const realRandom = Math.random
	let clock = 1_000_000
	Date.now = () => clock
	Math.random = () => 0.75
	try {
		const listener = {}
		const cam = fresh()
		const fx = createDamageEffects(null, cam, listener)

		expect('effects object exposes every control', API.every(key => typeof fx[key] === 'function'), API.filter(key => typeof fx[key] !== 'function').join(',') || 'complete')
		expect('defaults are screen shake on and sound on', configIs(fx.getConfig(), { screenShakeEnabled: true, soundEnabled: true }), JSON.stringify(fx.getConfig()))
		expect('no shake is active before any damage', fx.getActiveShake() === null)

		const hit = fx.triggerDamage(10, { x: 1, y: 2, z: 3 }, { hitDirection: { x: 0, y: 0, z: 1 }, showNumbers: true })
		expect('triggerDamage echoes damage, position, hit direction and showNumbers', hit.damage === 10 && hit.position.x === 1 && hit.position.y === 2 && hit.position.z === 3 && hit.hitDirection.z === 1 && hit.showNumbers === true)
		expect('triggerDamage reports a screen shake when enabled', hit.hasScreenShake === true)

		const shake = fx.getActiveShake()
		expect('an active shake exists right after the hit', shake !== null)
		expect('shake intensity is damage / 20', shake?.intensity === 0.5, String(shake?.intensity))
		expect('shake duration is 150 + 2 * damage ms', shake?.duration === 170, String(shake?.duration))
		expect('shake max offset is 0.25 * intensity', shake?.maxOffset === 0.125, String(shake?.maxOffset))
		expect('shake starts at the current clock', shake?.startTime === clock)

		const limit = shake?.maxOffset ?? 0
		const at = { x: cam.position.x, y: cam.position.y, z: cam.position.z }
		fx.update()
		expect('update offsets the camera while the shake is active', cam.position.x !== at.x || cam.position.y !== at.y, `dx=${cam.position.x - at.x} dy=${cam.position.y - at.y}`)
		expect('update never moves the camera depth', cam.position.z === at.z)
		expect('camera offset stays within the shake max offset', Math.abs(cam.position.x) <= limit && Math.abs(cam.position.y) <= limit)

		clock = shake.startTime + shake.duration - 1
		const beforeLate = cam.position.x
		expect('shake is still active one millisecond before its duration', fx.getActiveShake() !== null)
		fx.update()
		expect('update keeps offsetting the camera until expiry', cam.position.x !== beforeLate)

		clock += 1
		expect('shake is inactive at its duration boundary', fx.getActiveShake() === null)
		const expired = { x: cam.position.x, y: cam.position.y }
		fx.update()
		expect('update after expiry leaves the camera untouched', cam.position.x === expired.x && cam.position.y === expired.y)
		expect('no shake remains after expiry', fx.getActiveShake() === null)

		const big = fx.triggerDamage(1000, origin)
		const bigShake = fx.getActiveShake()
		expect('a large hit still reports a screen shake', big.hasScreenShake === true)
		expect('shake intensity is capped at 3', bigShake?.intensity === 3, String(bigShake?.intensity))
		expect('shake duration scales with damage', bigShake?.duration === 2150, String(bigShake?.duration))

		fx.triggerDamage(10, origin, { screenShakeIntensity: 2 })
		const explicit = fx.getActiveShake()
		expect('explicit screenShakeIntensity overrides damage / 20', explicit?.intensity === 2 && explicit?.maxOffset === 0.5, `intensity=${explicit?.intensity} maxOffset=${explicit?.maxOffset}`)

		fx.setScreenShake(false)
		expect('setScreenShake(false) turns screen shake off in accessor and config', fx.screenShakeEnabled() === false && fx.getConfig().screenShakeEnabled === false)
		const quiet = fx.triggerDamage(10, origin)
		expect('a hit with screen shake disabled reports no shake', quiet.hasScreenShake === false)
		expect('no active shake exists while screen shake is disabled', fx.getActiveShake() === null)
		const still = { x: cam.position.x, y: cam.position.y }
		fx.update()
		expect('update leaves the camera untouched while screen shake is disabled', cam.position.x === still.x && cam.position.y === still.y)

		fx.setScreenShake(true)
		const restored = fx.triggerDamage(10, origin)
		expect('setScreenShake(true) restores shakes on the next hit', fx.screenShakeEnabled() === true && restored.hasScreenShake === true && fx.getActiveShake() !== null)

		const sounds = createDamageEffects(null, fresh(), listener)
		expect('a sound-enabled hit with a listener and no window global does not throw', noThrow(() => sounds.triggerDamage(10, origin)))
		sounds.setSound(false)
		expect('setSound(false) turns sound off in accessor and config', sounds.soundEnabled() === false && sounds.getConfig().soundEnabled === false)
		expect('a muted hit does not throw', noThrow(() => sounds.triggerDamage(10, origin)))
		sounds.setSound(true)
		expect('setSound(true) turns sound back on', sounds.soundEnabled() === true)
		const deaf = createDamageEffects(null, fresh(), null)
		expect('a hit without an audio listener does not throw', noThrow(() => deaf.triggerDamage(10, origin)))

		const configured = createDamageEffects(null, fresh(), listener, { screenShakeEnabled: false })
		expect('constructor config overrides the defaults it names', configIs(configured.getConfig(), { screenShakeEnabled: false, soundEnabled: true }), JSON.stringify(configured.getConfig()))
		expect('constructor screenShakeEnabled false suppresses shake', configured.triggerDamage(10, origin).hasScreenShake === false)
		const replaced = configured.setConfig({ soundEnabled: false })
		expect('setConfig returns the resulting config', configIs(replaced, { screenShakeEnabled: true, soundEnabled: false }), JSON.stringify(replaced))
		expect('setConfig re-applies defaults for keys it omits', configured.getConfig().screenShakeEnabled === true)
		configured.getConfig().soundEnabled = true
		expect('getConfig returns a copy that cannot change settings', configured.getConfig().soundEnabled === false)
		configured.setConfig({ screenShakeEnabled: false, soundEnabled: true })
		expect('setConfig with both keys sets both', configIs(configured.getConfig(), { screenShakeEnabled: false, soundEnabled: true }))
	} finally {
		Date.now = realNow
		Math.random = realRandom
	}
}

let thrown = null
try {
	await exercise()
} catch (err) {
	thrown = err
}
if (thrown) expect('witness ran to completion without an uncaught error', false, String(thrown?.message ?? thrown))
const failed = checks.filter(ok => !ok).length
console.log(`checks=${checks.length} failed=${failed}`)
const pass = checks.length > 0 && failed === 0
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
