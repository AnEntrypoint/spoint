import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'

const WITNESS_ID = 'IKSolver-witness'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MODULE = path.resolve(SCRIPT_DIR, '..', 'src', 'animation', 'IKSolver.js')
const EPSILON = 1e-6
const BROWSER_OR_GPU_TOKENS = [
  'window', 'document', 'navigator', 'WebGL', 'WebGPU', 'GPUDevice',
  'WebSocket', 'Worker', 'fetch(', 'require(', 'import(',
]

const lines = []
const failedIds = []
const characterizedIds = []
let correctCount = 0

function flagValue(name) {
  const prefix = `--${name}=`
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return hit === undefined ? null : hit.slice(prefix.length)
}

function format(value) {
  if (typeof value === 'number') return value.toFixed(6)
  if (Array.isArray(value)) return `[${value.map(format).join(',')}]`
  return String(value)
}

function same(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item, index) => same(item, actual[index]))
  }
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(expected - actual) <= EPSILON
  }
  return expected === actual
}

function check(id, label, expected, actual, note = '') {
  const passed = same(expected, actual)
  if (!passed) failedIds.push(id)
  if (id.startsWith('CHAR-')) characterizedIds.push(id)
  else correctCount += 1
  lines.push(`check ${id} ${passed ? 'PASS' : 'FAIL'} ${label} expected=${format(expected)} got=${format(actual)}${note}`)
}

const vec = (v) => [v.x, v.y, v.z]
const quat = (o) => [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]
const worldPos = (o) => vec(o.getWorldPosition(new THREE.Vector3()))

function buildRig({ rootAt, middleAt, endAt, flat = false }) {
  const parent = new THREE.Object3D()
  const root = new THREE.Object3D()
  const middle = new THREE.Object3D()
  const end = new THREE.Object3D()
  root.position.set(...rootAt)
  middle.position.set(...middleAt)
  end.position.set(...endAt)
  parent.add(root)
  if (flat) {
    parent.add(middle)
    parent.add(end)
  } else {
    root.add(middle)
    middle.add(end)
  }
  parent.updateMatrixWorld(true)
  return { parent, root, middle, end }
}

function runStaticGate(source) {
  const lowered = source.toLowerCase()
  const tokenHits = BROWSER_OR_GPU_TOKENS.filter((token) => lowered.includes(token.toLowerCase()))
  check('S1', 'node-only gate: no browser, GPU, worker, fetch, require or dynamic import token', [], tokenHits)
  const nondeterminism = []
  if (source.includes('Math.random')) nondeterminism.push('Math.random')
  if (/\bDate\b/.test(source)) nondeterminism.push('Date')
  check('S2', 'no Math.random or Date in module, so no seed is needed', [], nondeterminism)
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  check('S3', 'only static import is the bare three package', ['three'], specifiers)
}

function runApiChecks(mod) {
  const { TwoBoneIKSolver, FootIKSolver, IKChain, IKRig } = mod
  const pole = new THREE.Vector3(1, 0, 0)

  check('A1', 'named exports', ['FootIKSolver', 'IKChain', 'IKRig', 'TwoBoneIKSolver', 'default'], Object.keys(mod).sort())
  check('A2', 'default export keys', ['FootIKSolver', 'IKChain', 'IKRig', 'TwoBoneIKSolver'], Object.keys(mod.default).sort())
  check('A3', 'default export holds the same class references', [true, true, true, true], [
    mod.default.TwoBoneIKSolver === TwoBoneIKSolver,
    mod.default.FootIKSolver === FootIKSolver,
    mod.default.IKChain === IKChain,
    mod.default.IKRig === IKRig,
  ])

  const flatRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 2, 0], flat: true })
  const flatSolver = new TwoBoneIKSolver(flatRig.root, flatRig.middle, flatRig.end)
  check('B1', 'defaults: target, poleVector, enabled, weight, tolerance, useWorldSpace',
    [[0, 0, 0], [1, 0, 0], true, 1, 0.001, true],
    [vec(flatSolver.target), vec(flatSolver.poleVector), flatSolver.enabled, flatSolver.weight, flatSolver.tolerance, flatSolver.useWorldSpace])
  const tuned = new TwoBoneIKSolver(flatRig.root, flatRig.middle, flatRig.end, { tolerance: 0.5, useWorldSpace: false })
  check('B2', 'options override tolerance and useWorldSpace', [0.5, false], [tuned.tolerance, tuned.useWorldSpace])
  const targetSource = new THREE.Vector3(1, 2, 3)
  const targetReturned = flatSolver.setTarget(targetSource)
  targetSource.set(9, 9, 9)
  check('B3', 'setTarget copies its argument and returns the solver', [true, [1, 2, 3]], [targetReturned === flatSolver, vec(flatSolver.target)])
  const poleReturned = flatSolver.setPoleVector(new THREE.Vector3(0, 3, 4))
  check('B4', 'setPoleVector normalises its argument and returns the solver', [true, [0, 0.6, 0.8]], [poleReturned === flatSolver, vec(flatSolver.poleVector)])
  check('B5', 'solve returns the solver', true, flatSolver.solve() === flatSolver)

  const disabledRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 1, 0] })
  const disabledSolver = new TwoBoneIKSolver(disabledRig.root, disabledRig.middle, disabledRig.end)
  disabledSolver.enabled = false
  disabledSolver.setTarget(new THREE.Vector3(1, 1, 0))
  const rootBeforeDisabled = quat(disabledRig.root)
  const middleBeforeDisabled = quat(disabledRig.middle)
  disabledSolver.solve()
  check('B6', 'disabled solver leaves both bone rotations unchanged', [rootBeforeDisabled, middleBeforeDisabled], [quat(disabledRig.root), quat(disabledRig.middle)])

  const atRootRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 1, 0] })
  const atRootSolver = new TwoBoneIKSolver(atRootRig.root, atRootRig.middle, atRootRig.end)
  atRootSolver.setTarget(new THREE.Vector3(0, 0, 0))
  const rootBeforeAtRoot = quat(atRootRig.root)
  atRootSolver.solve()
  check('B7', 'target at the root, under tolerance, leaves rotations unchanged', rootBeforeAtRoot, quat(atRootRig.root))

  const parentless = { root: new THREE.Object3D(), middle: new THREE.Object3D(), end: new THREE.Object3D() }
  parentless.middle.position.set(0, 1, 0)
  parentless.end.position.set(0, 1, 0)
  parentless.root.add(parentless.middle)
  parentless.middle.add(parentless.end)
  const parentlessSolver = new TwoBoneIKSolver(parentless.root, parentless.middle, parentless.end)
  parentlessSolver.setTarget(new THREE.Vector3(1, 1, 0))
  const rootBeforeParentless = quat(parentless.root)
  parentlessSolver.solve()
  check('CHAR-L1', 'limitation: a root with no parent is never rotated by solve', rootBeforeParentless, quat(parentless.root), ' analytic=rotated')

  check('C1', 'flat layout: rootLength and middleLength equal the bone lengths', [1, 1], [flatSolver.rootLength, flatSolver.middleLength])
  const unitRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 1, 0] })
  const unitSolver = new TwoBoneIKSolver(unitRig.root, unitRig.middle, unitRig.end)
  check('C2', 'hierarchical unit rig: rootLength equals 1 when the root sits at the parent origin', 1, unitSolver.rootLength)
  check('X1a', 'hierarchical unit rig: middleLength equals 1', 1, unitSolver.middleLength)
  const offsetRig = buildRig({ rootAt: [0, 0.9, 0], middleAt: [0, 0.5, 0], endAt: [0, 0.5, 0] })
  const offsetSolver = new TwoBoneIKSolver(offsetRig.root, offsetRig.middle, offsetRig.end)
  check('X1b', 'offset rig: rootLength equals 0.5', 0.5, offsetSolver.rootLength)
  check('X1c', 'offset rig: middleLength equals 0.5', 0.5, offsetSolver.middleLength)

  const reachRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 1, 0] })
  const reachSolver = new TwoBoneIKSolver(reachRig.root, reachRig.middle, reachRig.end)
  reachSolver.setTarget(new THREE.Vector3(1, 1, 0)).setPoleVector(pole)
  reachSolver.solve()
  check('X2a', 'reach (1,1,0): middle world position equals (1,0,0)', [1, 0, 0], worldPos(reachRig.middle))
  check('X2b', 'reach (1,1,0): end world position equals (1,1,0)', [1, 1, 0], worldPos(reachRig.end))

  const bentRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 1, 0] })
  const bentSolver = new TwoBoneIKSolver(bentRig.root, bentRig.middle, bentRig.end)
  bentSolver.setTarget(new THREE.Vector3(0, 1.5, 0)).setPoleVector(pole)
  bentSolver.solve()
  check('X2c', 'reach (0,1.5,0): middle world position equals (0.661438,0.75,0)', [0.661438, 0.75, 0], worldPos(bentRig.middle))
  check('X2d', 'reach (0,1.5,0): end world position equals (0,1.5,0)', [0, 1.5, 0], worldPos(bentRig.end))

  const clampRig = buildRig({ rootAt: [0, 0, 0], middleAt: [0, 1, 0], endAt: [0, 1, 0] })
  const clampSolver = new TwoBoneIKSolver(clampRig.root, clampRig.middle, clampRig.end)
  clampSolver.setTarget(new THREE.Vector3(10, 0, 0)).setPoleVector(pole)
  clampSolver.solve()
  check('G1', 'unreachable target (10,0,0) clamps to full extension: middle at (1,0,0)', [1, 0, 0], worldPos(clampRig.middle))
  check('G2', 'unreachable target (10,0,0) clamps to full extension: end at (2,0,0)', [2, 0, 0], worldPos(clampRig.end))

  const footBone = new THREE.Object3D()
  footBone.position.set(0, 0.5, 0)
  const rayCalls = []
  const footSolver = new FootIKSolver(footBone, (rayOrigin, rayDirection, rayLength) => {
    rayCalls.push({ rayOrigin: vec(rayOrigin), rayDirection: vec(rayDirection), rayLength })
    return new THREE.Vector3(0, 0.3, 0)
  }, { rayDistance: 4 })
  const footReturned = footSolver.solve()
  const firstRay = rayCalls[0] ?? {}
  check('E1', 'ray starts half its length above the foot, points down, has rayDistance length',
    [[0, 2.5, 0], [0, -1, 0], 4], [firstRay.rayOrigin, firstRay.rayDirection, firstRay.rayLength])
  check('E2', 'full weight moves the foot to the hit height and returns the solver',
    [0.3, true], [footBone.position.y, footReturned === footSolver])
  const halfFoot = new THREE.Object3D()
  halfFoot.position.set(0, 0.5, 0)
  const halfSolver = new FootIKSolver(halfFoot, () => new THREE.Vector3(0, 0.3, 0), { rayDistance: 4 })
  halfSolver.weight = 0.5
  halfSolver.solve()
  check('E3', 'weight scales the height correction', 0.4, halfFoot.position.y)
  const missFoot = new THREE.Object3D()
  missFoot.position.set(0, 0.5, 0)
  new FootIKSolver(missFoot, () => null).solve()
  check('E4', 'no hit leaves the foot unchanged', 0.5, missFoot.position.y)
  const idleFoot = new THREE.Object3D()
  idleFoot.position.set(0, 0.5, 0)
  let idleCalls = 0
  const idleSolver = new FootIKSolver(idleFoot, () => { idleCalls += 1; return new THREE.Vector3(0, 0, 0) })
  idleSolver.enabled = false
  idleSolver.solve()
  check('E5', 'disabled foot solver casts no ray and leaves the foot unchanged', [0, 0.5], [idleCalls, idleFoot.position.y])
  check('E6', 'default rayDistance is 10', 10, new FootIKSolver(idleFoot, () => null).rayDistance)
  const carrier = new THREE.Object3D()
  carrier.position.set(0, 10, 0)
  const parentedFoot = new THREE.Object3D()
  parentedFoot.position.set(0, 0.5, 0)
  carrier.add(parentedFoot)
  carrier.updateMatrixWorld(true)
  new FootIKSolver(parentedFoot, () => new THREE.Vector3(0, 10.3, 0)).solve()
  carrier.updateMatrixWorld(true)
  check('X3a', 'foot under a parent at y=10, hit world y=10.3: local y is 0.3', 0.3, parentedFoot.position.y)
  check('X3b', 'same foot: world y is 10.3', 10.3, worldPos(parentedFoot)[1])

  const order = []
  const chain = new IKChain('leg')
  const chained = chain.addSolver({ solve() { order.push('A') } })
    .addSolver(null)
    .addSolver({})
    .addSolver({ solve() { order.push('B') } })
  chain.solve()
  check('F1', 'chain calls solve on each valid solver in insertion order', ['A', 'B'], order)
  check('F2', 'addSolver returns the chain and the name is kept', [true, 'leg'], [chained === chain, chain.name])
  chain.disable()
  order.length = 0
  chain.solve()
  check('F3', 'disabled chain calls no solver', 0, order.length)
  check('F4', 'enable and disable return the chain', [true, true], [chain.enable() === chain, chain.disable() === chain])

  const rig = new IKRig({})
  const arm = rig.createChain('arm')
  check('R1', 'createChain returns an IKChain registered by name; unknown names are undefined',
    [true, 'arm', true, undefined], [arm instanceof IKChain, arm.name, rig.getChain('arm') === arm, rig.getChain('missing')])
  let solved = 0
  arm.solve = () => { solved += 1 }
  rig.update()
  check('R2', 'update solves every chain while enabled', 1, solved)
  rig.disable()
  rig.update()
  check('R3', 'disabled rig does not solve chains', 1, solved)
  check('R4', 'enable and disable return the rig', [true, true], [rig.enable() === rig, rig.disable() === rig])
}

async function main() {
  const modulePath = path.resolve(flagValue('module') ?? DEFAULT_MODULE)
  const outFlag = flagValue('out')
  const logFlag = flagValue('log')
  const outPath = outFlag === null ? null : path.resolve(outFlag)
  const logPath = logFlag === null ? null : path.resolve(logFlag)

  if (outPath !== null) {
    check('O1', 'output path is new (create-only)', 'absent', fs.existsSync(outPath) ? 'present' : 'absent')
  }

  const moduleExists = fs.existsSync(modulePath)
  if (moduleExists) {
    const source = fs.readFileSync(modulePath, 'utf8')
    runStaticGate(source)
    let mod = null
    try {
      mod = await import(pathToFileURL(modulePath).href)
      check('L1', 'module imports without error', 'loaded', 'loaded')
    } catch (error) {
      check('L1', 'module imports without error', 'loaded', `error:${String(error.message).split('\n')[0]}`)
    }
    if (mod !== null) runApiChecks(mod)
  } else {
    check('L0', 'module file is present', true, false)
  }

  const moduleSha = moduleExists
    ? crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex')
    : 'absent'
  const passed = failedIds.length === 0
  const resultLine = passed ? 'RESULT: PASS' : 'RESULT: FAIL'
  const ts = new Date().toISOString()
  const text = [
    `witness=${WITNESS_ID}`,
    `ts=${ts}`,
    `module=${modulePath}`,
    `module_sha256=${moduleSha}`,
    `three_revision=${THREE.REVISION}`,
    `node=${process.version}`,
    ...lines,
    `summary checks=${correctCount + characterizedIds.length} correct=${correctCount} characterized=${characterizedIds.length} failed=${failedIds.length}`,
    `characterized_ids=${characterizedIds.join(',') || 'none'}`,
    resultLine,
    '',
  ].join('\n')

  if (outPath !== null && !fs.existsSync(outPath)) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, text, { flag: 'wx' })
  }
  if (logPath !== null) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${ts} ${WITNESS_ID} exit=${passed ? 0 : 1} ${resultLine} module=${modulePath} out=${outPath ?? '-'}\n`)
  }
  process.stdout.write(text)
  process.exitCode = passed ? 0 : 1
}

main().catch((error) => {
  process.stdout.write(`witness=${WITNESS_ID}\nerror=${String((error && error.stack) || error).split('\n')[0]}\nRESULT: FAIL\n`)
  process.exitCode = 1
})
