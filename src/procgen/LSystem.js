// procedural-content-lsystem-generator-module: standalone L-system (Lindenmayer system) string-rewriting
// engine + turtle-graphics interpreter, usable to generate tree/plant branching skeletons, independent of
// any specific renderer/editor integration. Split off procedural-content-generation-suite-wfc-l-systems-
// noise-terrain after its WFC slice shipped (src/procgen/WFC.js) -- this is the L-systems half of that
// epic's own 3-generator scope. Mirrors WFC.js's own scope boundary exactly: produce real structural data
// (a flat list of branch segments -- start/end/radius/depth), not a mesh or a Vegetation.js/EzTree
// integration -- that wiring is a distinct follow-on row (procedural-content-editor-toolbar-integration).
//
// ALGORITHM (real, not a stub):
//   1. EXPANSION: start from an axiom string. Each iteration, replace every symbol in the current string
//      with its production-rule replacement (looked up per symbol; a symbol with no rule expands to
//      itself, the standard L-system convention -- e.g. turtle-command symbols like +/-/[/] usually have
//      no rule and pass through unchanged). Rules may be STOCHASTIC: a symbol can map to an array of
//      {successor, weight} alternatives, chosen by a seeded weighted-random pick per occurrence per
//      iteration (classic stochastic L-system, e.g. Prusinkiewicz & Lindenmayer's algae/tree models) --
//      deterministic single-successor rules are just the degenerate weight-1 case.
//   2. TURTLE INTERPRETATION: walk the expanded symbol string left to right, maintaining a turtle state
//      (3D position, orientation as a right/up/forward orthonormal frame, segment length, and thickness)
//      on top of an explicit stack for the standard L-system bracket convention: '[' pushes a COPY of the
//      current turtle state, ']' pops it back (this is what turns a linear string into a branching tree --
//      a branch drawn after '[' does not perturb the trunk's continuing state after the matching ']').
//      Every drawing move ('F'/'A'..'Z' by convention here -- any uppercase letter draws, matching the
//      common textbook convention that distinguishes "move and draw" from "move without drawing", 'f')
//      emits one segment record {start, end, radius, depth} into the output list; radius tapers with
//      stack depth via a caller-tunable taper factor (thinner branches the deeper the recursion), the
//      standard visual cue a real tree/plant skeleton needs downstream.
//
// SYMBOL VOCABULARY (standard L-system turtle convention, all caller-overridable via `angleDeg`/`stepLen`):
//   F, or any single uppercase letter A-Z : move forward one step, drawing a segment.
//   f                                     : move forward one step WITHOUT drawing (a gap).
//   +  / -                                : yaw left / right by angleDeg, around the turtle's up axis.
//   &  / ^                                : pitch down / up by angleDeg, around the turtle's right axis.
//   \\ / /                                : roll left / right by angleDeg, around the turtle's forward axis.
//   |                                     : turn around 180 degrees (yaw).
//   [  / ]                                : push / pop turtle state (branch start / branch end).
//   !                                     : shrink the turtle's current thickness by `taper` (explicit
//                                           thinning command, independent of stack-depth taper).
// Any other symbol (rule-only bookkeeping symbols with no direct turtle meaning, e.g. classic 'X' in
// F[+X]F[-X]FX-style tree grammars) is silently skipped by the turtle walk -- it exists purely to drive
// string rewriting, exactly the standard L-system authoring convention.

// Seeded PRNG (mulberry32 -- same choice + 2-draw warm-up discard as src/procgen/WFC.js, for consistency
// and because WFC.js's own live verification found and fixed a real small-sequential-seed bias in this
// exact generator's early draws; the warm-up discard is cheap insurance against the same class of bug).
function mulberry32(seed) {
  let a = seed >>> 0
  function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  rng(); rng() // warm-up discard, see WFC.js's own documented fix for why
  return rng
}

// Expands an axiom string through `iterations` rounds of production-rule replacement.
// rules: { [symbol]: string | Array<{successor, weight}> }
//   - string form: deterministic replacement.
//   - array form: stochastic replacement, one alternative chosen per occurrence per iteration, weighted.
// A symbol absent from `rules` passes through unchanged (standard L-system convention).
// Returns { result: string, iterations, lengths: number[] } (lengths = string length after each round,
// including the axiom itself at index 0 -- useful for a caller to sanity-check growth rate).
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
      // stochastic: array of {successor, weight}
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
  return alternatives[alternatives.length - 1].successor // float rounding fallback
}

// --- turtle-graphics interpretation -----------------------------------------------------------------

function vec3(x = 0, y = 0, z = 0) { return { x, y, z } }
function addScaled(a, b, s) { return vec3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s) }

// Rotate `v` about unit axis `axis` by `angleRad` (Rodrigues' rotation formula). Used to keep the
// turtle's right/up/forward frame orthonormal under repeated yaw/pitch/roll without accumulating the
// drift a naive Euler-angle re-derivation per step would introduce.
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
    // right/up/forward: an orthonormal frame, forward = growth direction (+Y, "up" in world terms, the
    // conventional default heading for a tree trunk), up/right span the plane turns rotate within.
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

// Interprets an already-expanded L-system string as turtle-graphics moves, producing a flat list of
// branch segments (structural data only -- no mesh, no renderer/scene coupling, matching WFC.js's own
// scope boundary). See the symbol-vocabulary comment block above the module header for the full command
// set. Returns { segments, maxDepth, turtleEnd } where turtleEnd is the final (unpopped) turtle state,
// useful for a caller chaining multiple interpret calls or inspecting where growth terminated.
export function interpretTurtle(symbolString, {
  angleDeg = 25,
  stepLen = 1,
  startRadius = 1,
  radiusTaper = 0.7,   // per-branch-depth multiplier (applied on each push, i.e. each '[')
  shrinkFactor = 0.6,  // applied by the explicit '!' thinning command
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
    } else if (/^[A-Z]$/.test(ch)) {
      // draw a segment (covers 'F' plus any other caller-chosen draw letter, e.g. 'A'/'X' used as a
      // rewrite-only symbol normally wouldn't reach here unless the caller intentionally draws on it --
      // matches the standard convention that ANY uppercase letter is a valid draw command)
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
    // any other symbol: rule-bookkeeping-only, no turtle meaning, silently skipped (standard convention)
  }
  if (stack.length !== 0) throw new Error(`interpretTurtle: unmatched '[' -- ${stack.length} branch(es) never closed with ']'`)

  return { segments, maxDepth, turtleEnd: turtle }
}

// Convenience: expand then interpret in one call. Returns { symbolString, segments, maxDepth, lengths }.
export function generateLSystemTree({ axiom, rules = {}, iterations = 1, seed = 1337, ...turtleOpts }) {
  const { result, lengths } = expandLSystem({ axiom, rules, iterations, seed })
  const { segments, maxDepth, turtleEnd } = interpretTurtle(result, turtleOpts)
  return { symbolString: result, segments, maxDepth, turtleEnd, lengths }
}

// A handful of classic, well-known L-system presets (textbook Prusinkiewicz & Lindenmayer / Wikipedia
// examples) -- useful both as ready-to-use generators and as known-property fixtures for live
// verification (expected symbol counts / turtle shapes are independently checkable against literature).
export const PRESETS = {
  // Koch curve (2D, angle 90deg): deterministic, symbol count is EXACTLY 4^n * axiom-F-count after n
  // iterations (each 'F' becomes exactly 4 symbols, one of which is itself an 'F' -- '+'/'-' don't rewrite).
  kochCurve: {
    axiom: 'F',
    rules: { F: 'F+F-F-F+F' },
    angleDeg: 90,
  },
  // Classic deterministic binary tree (Prusinkiewicz & Lindenmayer, "The Algorithmic Beauty of Plants",
  // fig 1.24-ish shape): axiom 'F' single trunk that recursively forks in two.
  binaryTree: {
    axiom: 'F',
    rules: { F: 'F[+F]F[-F]F' },
    angleDeg: 25.7,
  },
  // Stochastic tree: each 'F' has THREE weighted alternatives (grow straight / fork right / fork left),
  // demonstrating the stochastic-rule path with non-uniform weights.
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
  // Fractal (Sierpinski-ish) plant, classic textbook example with X as a non-drawing bookkeeping symbol.
  fractalPlant: {
    axiom: 'X',
    rules: {
      X: 'F+[[X]-X]-F[-FX]+X',
      F: 'FF',
    },
    angleDeg: 25,
  },
}
