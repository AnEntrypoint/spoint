import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localToDeformed } from '../packages/mapspinner/src/quadtree.js'

const SRC_ROOT = fileURLToPath(new URL('../packages/mapspinner/src', import.meta.url))

const QUARTER_LITERAL = /0\.7853981634/g
const QUARTER_PI_EXPR = /Math\.PI\s*\/\s*4\.0/g
const QUARTER_PI_NAME = /\bconst QUARTER_PI\b/g
const ATM_DECL = /ATM_SUN_ANGULAR_RADIUS(?::\s*f32)?\s*=\s*0\.004675/g
const ATM_REF = /\bATM_SUN_ANGULAR_RADIUS\b/g
const ANY_QUARTER_OR_ATM = /QUARTER_PI|0\.7853981634|ATM_SUN/g

const PINNED = {
  literalOccurrences: 8,
  literalFiles: 7,
  piExprOccurrences: 6,
  piExprFiles: 4,
  quarterPiDeclarations: 2,
  atmDeclarations: 3,
  glRenderAtmDeclarations: 0,
  glRenderAtmReferences: 1,
}

const failures = []
const expect = (label, got, want) => {
  if (got !== want) failures.push(`${label}: observed ${got}, pinned ${want}`)
}

function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '.gm' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else out.push(p)
  }
  return out
}

const countOf = (text, re) => (text.match(re) || []).length

const files = sourceFiles(SRC_ROOT).map((p) => ({ p, text: readFileSync(p, 'utf8') }))

let literal = 0
let literalFiles = 0
let piExpr = 0
let piExprFiles = 0
let quarterPi = 0
let atmDeclarations = 0
for (const f of files) {
  const lc = countOf(f.text, QUARTER_LITERAL)
  const pc = countOf(f.text, QUARTER_PI_EXPR)
  literal += lc
  piExpr += pc
  if (lc > 0) literalFiles++
  if (pc > 0) piExprFiles++
  quarterPi += countOf(f.text, QUARTER_PI_NAME)
  atmDeclarations += countOf(f.text, ATM_DECL)
}

expect('quarter-literal-occurrences', literal, PINNED.literalOccurrences)
expect('quarter-literal-files', literalFiles, PINNED.literalFiles)
expect('quarter-pi-expr-occurrences', piExpr, PINNED.piExprOccurrences)
expect('quarter-pi-expr-files', piExprFiles, PINNED.piExprFiles)
expect('quarter-pi-named-declarations', quarterPi, PINNED.quarterPiDeclarations)
expect('atm-sun-angular-radius-declarations', atmDeclarations, PINNED.atmDeclarations)

const literalDeviation = Math.abs(0.7853981634 - Math.PI / 4)
if (!(literalDeviation < 1e-11)) failures.push(`literal-deviation: observed ${literalDeviation}, ceiling 1e-11`)

const glRender = files.find((f) => f.p.endsWith(join('src', 'gl-render.js')) || f.p.endsWith('/gl-render.js'))
expect('gl-render-atm-declarations', countOf(glRender.text, ATM_DECL), PINNED.glRenderAtmDeclarations)
expect('gl-render-atm-references', countOf(glRender.text, ATM_REF), PINNED.glRenderAtmReferences)
if (!/'\.\/shaders\/atmosphere\.glsl'/.test(glRender.text)) failures.push('gl-render no longer fetches ./shaders/atmosphere.glsl, so its ATM_SUN_ANGULAR_RADIUS reference has no provider')

const indexText = readFileSync(join(SRC_ROOT, 'index.js'), 'utf8')
expect('index-exports-quarter-or-atm', countOf(indexText, ANY_QUARTER_OR_ATM), 0)

const R = 63600
const [gx, gy, gz] = localToDeformed(R, R, 0, R)
const observedQuarterAngle = Math.atan(gx / gz)
const observedDeviation = Math.abs(observedQuarterAngle - Math.PI / 4)
if (!(observedDeviation < 1e-12)) failures.push(`localToDeformed quarter-angle: observed ${observedQuarterAngle}, deviation ${observedDeviation} from Math.PI/4`)
if (gx !== gy) failures.push(`localToDeformed is not symmetric in x and y: ${gx} vs ${gy}`)

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.error('RESULT: FAIL quarterangle-characterization')
  process.exit(1)
}

console.log(
  `RESULT: PASS quarterangle-characterization spellings=${literal + piExpr} files=${literalFiles + piExprFiles}` +
    ` literal=${literal}/${literalFiles} pi-expr=${piExpr}/${piExprFiles} named-QUARTER_PI=${quarterPi}` +
    ` literal-deviation=${literalDeviation.toExponential(4)} observed-quarter-angle=${observedQuarterAngle}` +
    ` observed-deviation=${observedDeviation.toExponential(4)} atm-declarations=${atmDeclarations}` +
    ` gl-render-dangling-atm-refs=${countOf(glRender.text, ATM_REF)} index-exports=0`
)
