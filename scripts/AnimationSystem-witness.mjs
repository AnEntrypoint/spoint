import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'

const WITNESS_ID = 'AnimationSystem-witness'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MODULE = path.resolve(SCRIPT_DIR, '..', 'src', 'animation', 'AnimationSystem.js')
const EPSILON = 1e-6
const NEAR = 1e-4
const BROWSER_OR_GPU_TOKENS = [
  'window', 'document', 'navigator', 'WebGL', 'WebGPU', 'GPUDevice',
  'WebSocket', 'Worker', 'fetch(',
]
const EXPECTED_STATIC_SPECIFIERS = ['three', './SkeletonUtils.js', './BlendTree.js', './IKSolver.js', './AnimationController.js']
const EXPECTED_CLOSURE = ['AnimationController.js', 'AnimationSystem.js', 'BlendTree.js', 'IKSolver.js', 'SkeletonUtils.js', 'game-fsm.js']
const EXPECTED_METHODS = [
  'addClip', 'crossFade', 'disableIK', 'dispose', 'enableIK', 'getSkeletonBone',
  'initializeController', 'packSkeletonState', 'playAnimation', 'setBlendTree',
  'setIKTarget', 'unpackSkeletonState', 'update',
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

function same(expected, actual, tolerance) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item, index) => same(item, actual[index], tolerance))
  }
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(expected - actual) <= tolerance
  }
  return expected === actual
}

function check(id, label, expected, actual, note = '', tolerance = EPSILON) {
  const passed = same(expected, actual, tolerance)
  if (!passed) failedIds.push(id)
  if (id.startsWith('CHAR-')) characterizedIds.push(id)
  else correctCount += 1
  lines.push(`check ${id} ${passed ? 'PASS' : 'FAIL'} ${label} expected=${format(expected)} got=${format(actual)}${note}`)
}

const vec = (v) => [v.x, v.y, v.z]
const vec4 = (q) => [q.x, q.y, q.z, q.w]
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function makeBone(name, x, y, z) {
  const bone = new THREE.Bone()
  bone.name = name
  bone.position.set(x, y, z)
  return bone
}

function makeClip(name) {
  return new THREE.AnimationClip(name, 1, [])
}

function buildHumanoid({ arms = true, feet = true } = {}) {
  const model = new THREE.Group()
  const hips = makeBone('Hips', 0, 1, 0)
  model.add(hips)
  if (arms) {
    for (const [side, sign] of [['Left', -1], ['Right', 1]]) {
      const upper = makeBone(`${side}Arm`, 0.2 * sign, 0.4, 0)
      const lower = makeBone(`${side}ForeArm`, 0, -0.3, 0)
      const hand = makeBone(`${side}Hand`, 0, -0.3, 0)
      hips.add(upper)
      upper.add(lower)
      lower.add(hand)
    }
  }
  if (feet) {
    for (const [side, sign] of [['Left', -1], ['Right', 1]]) {
      hips.add(makeBone(`${side}Foot`, 0.1 * sign, -1, 0))
    }
  }
  model.updateMatrixWorld(true)
  return { model, hips }
}

async function loadSibling(modulePath, fileName) {
  return import(pathToFileURL(path.join(path.dirname(modulePath), fileName)).href)
}

function captureWarnings(action) {
  const original = console.warn
  const messages = []
  console.warn = (...args) => { messages.push(args.join(' ')) }
  try {
    return { result: action(), messages }
  } finally {
    console.warn = original
  }
}

function relativeSpecifiers(source) {
  return [...source.matchAll(/^\s*import\s[^'"]*['"](\.\.?\/[^'"]+)['"]/gm)].map((match) => match[1])
}

function importClosure(entry) {
  const closure = new Map()
  const queue = [path.resolve(entry)]
  while (queue.length > 0) {
    const file = queue.shift()
    if (closure.has(file) || !fs.existsSync(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    closure.set(file, source)
    for (const specifier of relativeSpecifiers(source)) {
      queue.push(path.resolve(path.dirname(file), specifier))
    }
  }
  return closure
}

function runStaticGate(modulePath, closure) {
  const tokenHits = []
  for (const [file, source] of closure) {
    const lowered = source.toLowerCase()
    for (const token of BROWSER_OR_GPU_TOKENS) {
      if (lowered.includes(token.toLowerCase())) tokenHits.push(`${path.basename(file)}:${token}`)
    }
  }
  check('S1', 'node-only gate: no browser, GPU, worker, socket or fetch token in the module import closure', [], tokenHits)
  const moduleSource = closure.get(path.resolve(modulePath))
  const specifiers = [...moduleSource.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  check('S2', 'module static imports are three plus its four relative siblings', EXPECTED_STATIC_SPECIFIERS, specifiers)
  check('S3', 'import closure is exactly the expected files', EXPECTED_CLOSURE, [...closure.keys()].map((file) => path.basename(file)).sort())
  const dynamicSites = [...closure.values()].reduce((count, source) => count + (source.match(/\bimport\s*\(/g) || []).length, 0)
  check('S4', 'dynamic import() sites in the closure (game-fsm xstate loader, Node branch)', 2, dynamicSites)
}

function runApiChecks(mod, sib) {
  const { AnimationSystem } = mod
  const { BlendTree1D, AnimationBlender } = sib.blend
  const { TwoBoneIKSolver, FootIKSolver } = sib.ik

  check('A1', 'named exports', ['AnimationSystem', 'default'], Object.keys(mod).sort())
  check('A2', 'default export is the AnimationSystem class', true, mod.default === AnimationSystem)
  const methods = Object.getOwnPropertyNames(AnimationSystem.prototype)
    .filter((name) => name !== 'constructor' && !name.startsWith('_'))
    .sort()
  check('A3', 'public prototype methods', [...EXPECTED_METHODS].sort(), methods)

  const adopted = new THREE.Group()
  adopted.skeleton = new THREE.Skeleton([makeBone('Hips', 0, 1, 0)])
  const adoptedSystem = new AnimationSystem(adopted)
  check('C1', 'model.skeleton is adopted as-is', [true, 1], [adoptedSystem.skeleton === adopted.skeleton, adoptedSystem.skeleton.bones.length])

  const meshHost = new THREE.Group()
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const meshBones = [makeBone('Hips', 0, 1, 0), makeBone('Spine', 0, 0.5, 0)]
  meshHost.add(mesh)
  meshHost.add(meshBones[0])
  mesh.bind(new THREE.Skeleton(meshBones))
  const meshSystem = new AnimationSystem(meshHost)
  check('C2', 'skeleton is taken from a SkinnedMesh descendant', true, meshSystem.skeleton === mesh.skeleton)

  const boneHost = new THREE.Group()
  const hipsBare = makeBone('Hips', 0, 1, 0)
  hipsBare.add(makeBone('Spine', 0, 0.5, 0))
  hipsBare.add(makeBone('RightArm', 0.2, 0.4, 0))
  boneHost.add(hipsBare)
  const boneSystem = new AnimationSystem(boneHost)
  check('C3', 'bare bones are collected into a new Skeleton in traversal order', ['Hips', 'Spine', 'RightArm'], boneSystem.skeleton.bones.map((item) => item.name))

  const emptySystem = new AnimationSystem(new THREE.Group())
  check('C4', 'no bones: skeleton is null and no IK chains are built', [null, 0], [emptySystem.skeleton, emptySystem.ikRig.chains.size])

  const defaults = new AnimationSystem(new THREE.Group())
  check('C5', 'default options', [true, true, '1d', null], [defaults.options.enableIK, defaults.options.enableFootIK, defaults.options.blendMode, defaults.options.raycastCallback])

  const overridden = new AnimationSystem(new THREE.Group(), { enableIK: false, blendMode: '2d' })
  check('C6', 'explicit options override the defaults', [false, true, '2d'], [overridden.options.enableIK, overridden.options.enableFootIK, overridden.options.blendMode])

  const idleClip = makeClip('Idle')
  const walkClip = makeClip('Walk')
  const seeded = new AnimationSystem(new THREE.Group(), { clips: [idleClip] })
  check('C7', 'options.clips are registered on the blender under their names', [true, true], [seeded.blender.clips.has('Idle'), seeded.blender.clips.get('Idle') === idleClip])

  const armsOnly = new AnimationSystem(buildHumanoid({ feet: false }).model)
  const leftArmChain = armsOnly.ikRig.getChain('leftArm')
  const rightArmChain = armsOnly.ikRig.getChain('rightArm')
  check('K1', 'humanoid arms build leftArm and rightArm chains with one solver each', [['leftArm', 'rightArm'], 1, 1], [[...armsOnly.ikRig.chains.keys()], leftArmChain.solvers.length, rightArmChain.solvers.length])
  check('K2', 'arm solvers are TwoBoneIKSolver instances', [true, true], [leftArmChain.solvers[0] instanceof TwoBoneIKSolver, rightArmChain.solvers[0] instanceof TwoBoneIKSolver])

  const footed = new AnimationSystem(buildHumanoid().model, { raycastCallback: () => null })
  check('K3', 'raycastCallback adds leftFoot and rightFoot chains after the arms', [['leftArm', 'rightArm', 'leftFoot', 'rightFoot'], true, true], [
    [...footed.ikRig.chains.keys()],
    footed.ikRig.getChain('leftFoot').solvers[0] instanceof FootIKSolver,
    footed.ikRig.getChain('rightFoot').solvers[0] instanceof FootIKSolver,
  ])

  const footDisabled = new AnimationSystem(buildHumanoid().model, { raycastCallback: () => null, enableFootIK: false })
  check('K4', 'enableFootIK:false suppresses the foot chains even with a raycast', ['leftArm', 'rightArm'], [...footDisabled.ikRig.chains.keys()])

  const hipsOnly = new AnimationSystem(buildHumanoid({ arms: false, feet: false }).model)
  check('K5', 'no humanoid limb bones: no chains', [], [...hipsOnly.ikRig.chains.keys()])

  const playSystem = new AnimationSystem(buildHumanoid({ arms: false, feet: false }).model, { clips: [idleClip] })
  const addReturns = playSystem.addClip('Walk', walkClip) === playSystem
  check('P1', 'addClip registers a clip by name and returns the system', [true, true], [addReturns, playSystem.blender.clips.has('Walk')])

  const playReturns = playSystem.playAnimation('Idle', 0.2) === playSystem
  check('P2', 'playAnimation plays the named clip and returns the system', [true, 'Idle', true], [playReturns, playSystem.blender.currentBlend, playSystem.blender.actions.get('Idle').isRunning()])

  const crossReturns = playSystem.crossFade('Idle', 'Walk', 0.2) === playSystem
  check('P3', 'crossFade makes the target current and returns the system', [true, 'Walk', true], [crossReturns, playSystem.blender.currentBlend, playSystem.blender.actions.get('Walk').isRunning()])

  playSystem.update(0.5)
  check('P4', 'once the 0.2 s fade has elapsed the outgoing clip contributes nothing', 0, playSystem.blender.actions.get('Idle').getEffectiveWeight())

  const unknown = captureWarnings(() => playSystem.playAnimation('Nope'))
  check('P5', 'unknown clip: one warning, and the system is still returned', [true, ['[AnimationBlender] Clip not found: Nope']], [unknown.result === playSystem, unknown.messages])

  const blendTree = new BlendTree1D()
  blendTree.addClip(idleClip, 0).addClip(walkClip, 1)
  blendTree.setParameter(0.25)
  check('P6', 'the BlendTree1D sibling computes the expected weights', [0.75, 0.25], blendTree.getWeights())
  const treeReturns = playSystem.setBlendTree(blendTree) === playSystem
  check('P7', 'setBlendTree stores the tree on the blender and returns the system', [true, true], [treeReturns, playSystem.blender.blendTree === blendTree])

  const blended = new AnimationSystem(new THREE.Group(), { clips: [idleClip, walkClip] })
  blended.setBlendTree(blendTree)
  blended.update(0.1)
  check('BT1', 'after update(0.1) the stored blend tree sets the clip weights to the tree weights 0.75 and 0.25', [0.75, 0.25], [blended.blender.actions.get('Idle').weight, blended.blender.actions.get('Walk').weight])

  const bareBlender = new AnimationBlender(new THREE.AnimationMixer(new THREE.Group()), [idleClip, walkClip])
  bareBlender.setBlendTree(blendTree)
  bareBlender.updateBlend(0.1)
  check('BT2', 'AnimationBlender.updateBlend evaluates a stored blend tree: the clip actions carry the tree weights 0.75 and 0.25', [0.75, 0.25], [bareBlender.actions.get('Idle').getEffectiveWeight(), bareBlender.actions.get('Walk').getEffectiveWeight()])

  const timer = new AnimationSystem(new THREE.Group())
  const timerReturns = timer.update(0.25) === timer
  check('P8', 'update advances the mixer by dt and returns the system', [true, 0.25], [timerReturns, timer.mixer.time])

  const controlled = new AnimationSystem(new THREE.Group(), { clips: [idleClip] })
  const controller = controlled.initializeController()
  check('P9', 'initializeController builds a controller with the default config', [true, 1.5, 'Idle'], [typeof controller.update === 'function', controller.config.walkSpeed, controller.config.idleClip])
  let secondOutcome = 'silent'
  try {
    controlled.initializeController({ walkSpeed: 9 })
  } catch {
    secondOutcome = 'threw'
  }
  if (secondOutcome === 'silent' && controller.config.walkSpeed === 9) secondOutcome = 'applied'
  check('CFG1', 'a second initializeController(options) either applies its options or throws, never silently ignores them', true, secondOutcome !== 'silent', ` outcome=${secondOutcome}`)

  const doubled = new AnimationSystem(new THREE.Group(), { clips: [idleClip] })
  doubled.initializeController()
  doubled.update(0.25, { speed: 0, isGrounded: true, verticalVelocity: 0 })
  check('P10', 'with a controller, update(dt) advances mixer time by dt exactly once', 0.25, doubled.mixer.time)

  const ikOff = new AnimationSystem(buildHumanoid().model, { enableIK: false })
  let ikOutcome = 'silent'
  try {
    ikOff.enableIK('rightArm')
  } catch {
    ikOutcome = 'threw'
  }
  if (ikOutcome === 'silent' && ikOff.ikRig.chains.size > 0) ikOutcome = 'built'
  check('CFG2', 'enableIK(chain) on a system built with enableIK:false either builds the chain or throws, never silently no-ops', true, ikOutcome !== 'silent', ` outcome=${ikOutcome} chains=${ikOff.ikRig.chains.size}`)

  const rig = buildHumanoid({ feet: false })
  const armSystem = new AnimationSystem(rig.model)
  const armChain = armSystem.ikRig.getChain('rightArm')
  const setReturns = armSystem.setIKTarget('rightArm', new THREE.Vector3(0.3, 1.2, 0.1), new THREE.Vector3(0, 3, 4)) === armSystem
  check('I1', 'setIKTarget copies the target and normalises the pole vector', [true, [0.3, 1.2, 0.1], [0, 0.6, 0.8]], [setReturns, vec(armChain.solvers[0].target), vec(armChain.solvers[0].poleVector)])

  const footSystem = new AnimationSystem(buildHumanoid({ arms: false }).model, { raycastCallback: () => null })
  const missingReturns = armSystem.setIKTarget('noSuchChain', new THREE.Vector3(1, 1, 1)) === armSystem
  const footReturns = footSystem.setIKTarget('leftFoot', new THREE.Vector3()) === footSystem
  check('I2', 'setIKTarget is a silent no-op for a missing chain and for a FootIK chain', [true, true], [missingReturns, footReturns])

  const toggled = [
    armSystem.disableIK('rightArm') === armSystem,
    armChain.enabled,
    armSystem.enableIK('rightArm') === armSystem,
    armChain.enabled,
  ]
  check('I3', 'disableIK and enableIK toggle the chain and return the system', [true, false, true, true], toggled)

  rig.model.updateMatrixWorld(true)
  const hand = rig.model.getObjectByName('RightHand')
  const restHand = vec(hand.getWorldPosition(new THREE.Vector3()))
  armSystem.setIKTarget('rightArm', new THREE.Vector3(0.3, 1.2, 0.1), new THREE.Vector3(1, 0, 0))
  armSystem.update(0)
  const solvedHand = vec(hand.getWorldPosition(new THREE.Vector3()))
  check('I4', 'update solves the right arm so the hand reaches a reachable target', [0.3, 1.2, 0.1], solvedHand, '', NEAR)
  check('I5', 'the solve moves the hand off its rest pose', true, distance(restHand, solvedHand) > 0.1)

  const stateSystem = new AnimationSystem(buildHumanoid().model)
  const boneCount = stateSystem.skeleton.bones.length
  const packed = new Int16Array(4 * boneCount)
  const packEnd = stateSystem.packSkeletonState(packed, 0)
  check('Q1', 'pack writes four int16 per bone from offset 0 and returns the end offset; identity packs to 0,0,0,32767', [4 * boneCount, 0, 0, 0, 32767], [packEnd, packed[0], packed[1], packed[2], packed[3]])

  const shifted = new Int16Array(8 + 4 * boneCount)
  const shiftEnd = stateSystem.packSkeletonState(shifted, 8)
  check('Q2', 'pack honours a start offset and leaves earlier entries untouched', [8 + 4 * boneCount, 0, 0, 0, 0, 32767], [shiftEnd, shifted[0] + shifted[7], shifted[8], shifted[9], shifted[10], shifted[11]])

  const hipsState = stateSystem.getSkeletonBone('Hips')
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
  hipsState.quaternion.copy(turned)
  const roundTrip = new Int16Array(4 * boneCount)
  stateSystem.packSkeletonState(roundTrip, 0)
  hipsState.quaternion.identity()
  const unpackEnd = stateSystem.unpackSkeletonState(roundTrip, 0)
  check('Q3', 'unpack restores a packed rotation within quantisation error and returns the end offset', [4 * boneCount, vec4(turned)], [unpackEnd, vec4(hipsState.quaternion)], '', 1e-4)

  const shiftedUnpack = stateSystem.unpackSkeletonState(shifted, 8)
  check('Q4', 'unpack honours a start offset and returns the end offset', 8 + 4 * boneCount, shiftedUnpack)

  check('G1', 'getSkeletonBone finds a bone by exact name', 'Hips', stateSystem.getSkeletonBone('Hips').name)
  check('G2', 'getSkeletonBone resolves a humanoid name through SkeletonUtils', 'LeftHand', stateSystem.getSkeletonBone('leftHand').name)
  check('G3', 'getSkeletonBone returns null for an unknown name', null, stateSystem.getSkeletonBone('nope'))

  const stopping = new AnimationSystem(buildHumanoid({ arms: false, feet: false }).model, { clips: [makeClip('Idle')] })
  stopping.playAnimation('Idle', 0.1)
  const wasRunning = stopping.blender.actions.get('Idle').isRunning()
  stopping.dispose()
  check('D1', 'dispose stops every mixer action', [true, false], [wasRunning, stopping.blender.actions.get('Idle').isRunning()])

  let disposeFailure = null
  try {
    controlled.dispose()
    doubled.dispose()
  } catch (error) {
    disposeFailure = error
  }
  check('D2', 'dispose with a controller completes without throwing', true, disposeFailure === null)
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
    const closure = importClosure(modulePath)
    runStaticGate(modulePath, closure)
    let mod = null
    let sib = null
    try {
      mod = await import(pathToFileURL(modulePath).href)
      sib = {
        blend: await loadSibling(modulePath, 'BlendTree.js'),
        ik: await loadSibling(modulePath, 'IKSolver.js'),
      }
      check('L1', 'module imports without error', 'loaded', 'loaded')
    } catch (error) {
      check('L1', 'module imports without error', 'loaded', `error:${String(error.message).split('\n')[0]}`)
    }
    if (mod !== null && sib !== null) {
      try {
        runApiChecks(mod, sib)
      } catch (error) {
        check('E0', 'API checks run to completion without an unexpected exception', 'completed', `error:${String(error.message).split('\n')[0]}`)
      }
    }
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
