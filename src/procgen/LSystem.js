function mulberry32(seed) {
  let a = seed >>> 0
  function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  rng(); rng()
  return rng
}

export function expandLSystem({ axiom, rules = {}, iterations = 1, seed = 1337 }) {
  if (typeof axiom !== 'string' || axiom.length === 0) throw new Error('expandLSystem: axiom must be a non-empty string')
  if (iterations < 0) throw new Error('expandLSystem: iterations must be >= 0')
  const rng = mulberry32(seed)
  let current = axiom
  const lengths = [current.length]
  for (let i = 0; i < iterations; i++) {
    let next = ''
    for (const ch of current) {
      const rule = rules[ch]
      if (rule === undefined) { next += ch; continue }
      if (typeof rule === 'string') { next += rule; continue }
      next += pickWeighted(rule, rng)
    }
    current = next
    lengths.push(current.length)
  }
  return { result: current, iterations, lengths }
}

function pickWeighted(alternatives, rng) {
  let total = 0
  for (const alt of alternatives) total += alt.weight ?? 1
  if (total <= 0) throw new Error('pickWeighted: alternatives must have positive total weight')
  let r = rng() * total
  for (const alt of alternatives) {
    r -= alt.weight ?? 1
    if (r <= 0) return alt.successor
  }
  return alternatives[alternatives.length - 1].successor
}

const DRAW_SYMBOL_PATTERN = /^[A-Z]$/

function vec3(x = 0, y = 0, z = 0) { return { x, y, z } }
function addScaled(a, b, s) { return vec3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s) }

function rotateAxis(v, axis, angleRad) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad)
  const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z
  const cross = vec3(
    axis.y * v.z - axis.z * v.y,
    axis.z * v.x - axis.x * v.z,
    axis.x * v.y - axis.y * v.x
  )
  return vec3(
    v.x * c + cross.x * s + axis.x * dot * (1 - c),
    v.y * c + cross.y * s + axis.y * dot * (1 - c),
    v.z * c + cross.z * s + axis.z * dot * (1 - c)
  )
}

function makeInitialTurtle() {
  return {
    pos: vec3(0, 0, 0),
    right: vec3(1, 0, 0),
    up: vec3(0, 0, 1),
    forward: vec3(0, 1, 0),
    radius: 1,
    depth: 0,
  }
}

function cloneTurtle(t) {
  return { pos: { ...t.pos }, right: { ...t.right }, up: { ...t.up }, forward: { ...t.forward }, radius: t.radius, depth: t.depth }
}

export function interpretTurtle(symbolString, {
  angleDeg = 25,
  stepLen = 1,
  startRadius = 1,
  radiusTaper = 0.7,
  shrinkFactor = 0.6,
  origin = undefined,
} = {}) {
  if (typeof symbolString !== 'string') throw new Error('interpretTurtle: symbolString must be a string')
  const angleRad = (angleDeg * Math.PI) / 180
  const segments = []
  const stack = []
  let turtle = makeInitialTurtle()
  turtle.radius = startRadius
  if (origin) turtle.pos = vec3(origin.x ?? 0, origin.y ?? 0, origin.z ?? 0)
  let maxDepth = 0

  for (const ch of symbolString) {
    if (ch === 'f') {
      turtle.pos = addScaled(turtle.pos, turtle.forward, stepLen)
    } else if (DRAW_SYMBOL_PATTERN.test(ch)) {
      const start = turtle.pos
      const end = addScaled(turtle.pos, turtle.forward, stepLen)
      segments.push({ start, end, radius: turtle.radius, depth: turtle.depth })
      turtle.pos = end
    } else if (ch === '+') {
      turtle.forward = rotateAxis(turtle.forward, turtle.up, angleRad)
      turtle.right = rotateAxis(turtle.right, turtle.up, angleRad)
    } else if (ch === '-') {
      turtle.forward = rotateAxis(turtle.forward, turtle.up, -angleRad)
      turtle.right = rotateAxis(turtle.right, turtle.up, -angleRad)
    } else if (ch === '&') {
      turtle.forward = rotateAxis(turtle.forward, turtle.right, angleRad)
      turtle.up = rotateAxis(turtle.up, turtle.right, angleRad)
    } else if (ch === '^') {
      turtle.forward = rotateAxis(turtle.forward, turtle.right, -angleRad)
      turtle.up = rotateAxis(turtle.up, turtle.right, -angleRad)
    } else if (ch === '\\') {
      turtle.right = rotateAxis(turtle.right, turtle.forward, angleRad)
      turtle.up = rotateAxis(turtle.up, turtle.forward, angleRad)
    } else if (ch === '/') {
      turtle.right = rotateAxis(turtle.right, turtle.forward, -angleRad)
      turtle.up = rotateAxis(turtle.up, turtle.forward, -angleRad)
    } else if (ch === '|') {
      turtle.forward = rotateAxis(turtle.forward, turtle.up, Math.PI)
      turtle.right = rotateAxis(turtle.right, turtle.up, Math.PI)
    } else if (ch === '[') {
      stack.push(cloneTurtle(turtle))
      turtle.depth += 1
      turtle.radius *= radiusTaper
      if (turtle.depth > maxDepth) maxDepth = turtle.depth
    } else if (ch === ']') {
      if (stack.length === 0) throw new Error("interpretTurtle: unmatched ']' -- more pops than pushes")
      turtle = stack.pop()
    } else if (ch === '!') {
      turtle.radius *= shrinkFactor
    }
  }
  if (stack.length !== 0) throw new Error(`interpretTurtle: unmatched '[' -- ${stack.length} branch(es) never closed with ']'`)

  return { segments, maxDepth, turtleEnd: turtle }
}

export function generateLSystemTree({ axiom, rules = {}, iterations = 1, seed = 1337, ...turtleOpts }) {
  const { result, lengths } = expandLSystem({ axiom, rules, iterations, seed })
  const { segments, maxDepth, turtleEnd } = interpretTurtle(result, turtleOpts)
  return { symbolString: result, segments, maxDepth, turtleEnd, lengths }
}

export const PRESETS = {
  kochCurve: {
    axiom: 'F',
    rules: { F: 'F+F-F-F+F' },
    angleDeg: 90,
  },
  binaryTree: {
    axiom: 'F',
    rules: { F: 'F[+F]F[-F]F' },
    angleDeg: 25.7,
  },
  stochasticTree: {
    axiom: 'F',
    rules: {
      F: [
        { successor: 'F[+F]F', weight: 1 },
        { successor: 'F[-F]F', weight: 1 },
        { successor: 'F[+F][-F]F', weight: 2 },
      ],
    },
    angleDeg: 22.5,
  },
  fractalPlant: {
    axiom: 'X',
    rules: {
      X: 'F+[[X]-X]-F[-FX]+X',
      F: 'FF',
    },
    angleDeg: 25,
  },
}
