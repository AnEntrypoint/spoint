#!/usr/bin/env node
// gen-height.mjs -- GLSL->JS transpiler for the terrain HEIGHT subset of
// src/shaders/terrain.glsl. The GLSL is the single source of truth (the author
// tunes it); this regenerates a pure-JS height module so headless physics samples
// the EXACT same surface the renderer displaces -- one source, two targets, zero
// manual mirror to drift. Re-run on every terrain.glsl edit (a build step / test).
//
// Scope: it transpiles a NAMED set of pure height functions (float/vec math,
// snoise3 noise, the fractal-terrain stack ending in composeHeight + continentalBias
// -- see HEIGHT_FNS below) -- NOT the texture-array HPF sampler (`hpfSample`, replaced
// at runtime by the pure-JS anchor-field) nor any FS/dFdx/texture code, nor the live
// per-player sculpt-override sampler (`sculptOverrideAt`, GPU-only: samples a
// host-pushed uSculptOverride texture the CPU height path has no access to -- see
// STUB_FNS below, emitted as an always-0 stub matching "no live sculpt edits", the
// correct CPU-oracle default; a caller that DOES need the server-authoritative sculpt
// contribution composes it separately via HeightDelta.wrapHeightFn, see terrain/HeightDelta.js
// and TerrainPhysics.js -- never through this GPU-only GLSL function). It handles:
// float/int/uint/bool/vecN/mat3 types, vec operator overloading (-> glsl-rt
// add/sub/mul/div), swizzles, vec constructors, `out` params (-> multi-return arrays),
// function overloads, the `?:` ternary, and for/if. Anything it does not recognise
// THROWS (fail-loud), so a new GLSL construct breaks generation visibly rather than
// silently diverging.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { strip, tokenize } from './gen-height-tokenizer.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'src/shaders/terrain.glsl'), 'utf8')

// The height-path functions to transpile, in dependency order (defs before uses).
const HEIGHT_FNS = [
  'h3', 'snoise3',
  'value_fbm', 'value_fbm_scaled',
  'rotate_domain', 'value_ridged_fbm_rot', 'value_ridged_fbm_rot_scaled',
  'eval_layer', 'sample_fractal_terrain',
  'fractalTerrainH', 'vhash', 'vnoise2', 'faceWarp',
  'composeHeight', 'continentalBias',
]
// Height-path functions that are GPU-texture-only (never transpiled from their real GLSL body)
// but ARE called from within a transpiled HEIGHT_FNS body, so the generated module needs SOME
// definition for the call to resolve at runtime -- emitted as a fixed always-0.0 JS stub instead
// of a transpiled function. This is the fail-LOUD-safe default for gen-height's own doc contract
// above (a texture/sampler2D-touching call it silently emits into a transpiled body must still
// resolve to a real, deliberately-chosen value, never a dangling free-variable ReferenceError).
// Adding a new texture-touching call to a HEIGHT_FNS body needs an explicit entry here (with a
// comment justifying the stub value) -- see the sculptOverrideAt entry for the precedent.
const STUB_FNS = {
  // sculptOverrideAt(dir0): live per-player sculpt-override delta, sampled from a host-pushed
  // uSculptOverride texture with no CPU-side representation. 0 matches "no live sculpt edits",
  // which is what every current CPU consumer (the physics-collider height oracle) wants -- the
  // server-authoritative sculpt contribution is composed separately via
  // HeightDelta.wrapHeightFn (see terrain/HeightDelta.js + TerrainPhysics.js), never through
  // this GPU-only GLSL function.
  sculptOverrideAt: { params: ['dir0'], body: '0.0' },
}
// Uniforms referenced by the height path -> read from a runtime `U` object. The
// height-cpu wrapper supplies the renderer's defaults so CPU == GPU.
const UNIFORMS = new Set([
  'uLandBias', 'uBeachShelfM', 'canyonDepthMul', 'uDetailOverlay', 'uHiFreqCut', 'uCarveWide',
  'uMtnBandWide', 'uClimateRelief', 'uIsleWide', 'uVsCheap', 'cliffAmt', 'vtxDetail', 'defRadius',
  'uOctMax', 'uInciseRidgeOcts', 'uBroadLowOcts', 'uPeakOcts', 'uDetailFbmOcts', 'uVtxBaseOcts', 'uVtxErodeOcts',
  'uNoUnroll',   // FXC anti-unroll loop bound (value-neutral at the default 64; see terrain.glsl)
])
// struct field order (for the HCache(...) constructor) -- parsed below but seeded here.
const STRUCTS = {}

// ---------- 1. strip comments + preprocessor, 2. tokenize (both in gen-height-tokenizer.mjs) ----------
const CODE = strip(SRC)

// ---------- 3. parser ----------
// A compact recursive-descent parser over the token stream, scoped to ONE function
// body at a time (we slice each function's tokens via brace matching first).
function sliceTopLevel(tokens) {
  // returns { structs:[{name,fields:[{type,name}]}], consts:[{type,name,tokens}], fns:[{ret,name,params,bodyTokens}] }
  const out = { structs: [], consts: [], fns: [] }
  let i = 0
  const peek = () => tokens[i], at = (k, v) => tokens[i].k === k && (v === undefined || tokens[i].v === v)
  const eat = () => tokens[i++]
  const skipQual = () => { while (at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'const') || at('kw', 'flat')) i++ }
  function matchBrace() { // assumes current token is '{'; returns tokens inside (excl braces)
    if (!at('op', '{')) throw new Error('expected {')
    const start = ++i; let d = 1
    while (d > 0) { if (at('op', '{')) d++; else if (at('op', '}')) d--; if (tokens[i].k === 'eof') throw new Error('unbalanced {'); i++ }
    return tokens.slice(start, i - 1)
  }
  function skipToSemi() { while (!at('op', ';') && tokens[i].k !== 'eof') i++; if (at('op', ';')) i++ }
  while (tokens[i].k !== 'eof') {
    // uniform decl: capture the name so any height-path uniform resolves to U.<name>.
    if (at('kw', 'uniform')) { eat(); while (at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'flat')) i++; if (peek().k === 'type' || peek().k === 'id') i++; if (peek().k === 'id') UNIFORMS.add(peek().v); skipToSemi(); continue }
    // skip varying/attribute/in/out/precision declarations
    if (at('kw', 'varying') || at('kw', 'attribute') || at('kw', 'precision') || at('kw', 'in') || at('kw', 'out') || at('kw', 'flat')) { skipToSemi(); continue }
    if (at('kw', 'struct')) {
      eat(); const name = eat().v; const fields = []
      const body = matchBrace()
      // parse fields: (qual)* type name ;
      let j = 0; const fb = body
      while (j < fb.length) {
        while (fb[j] && (fb[j].v === 'highp' || fb[j].v === 'mediump' || fb[j].v === 'lowp')) j++
        if (!fb[j]) break
        const type = fb[j++].v; const fname = fb[j++].v
        fields.push({ type, name: fname }); if (fb[j] && fb[j].v === ';') j++
      }
      STRUCTS[name] = fields.map(f => f.name)
      out.structs.push({ name, fields }); if (at('op', ';')) i++
      continue
    }
    // const decl:  const TYPE name = ... ;
    if (at('kw', 'const')) {
      const save = i; eat(); skipQual(); if (peek().k === 'type' || (peek().k === 'id' && STRUCTS[peek().v])) { const type = eat().v; const name = eat().v; if (at('op', '=')) { eat(); const start = i; skipToSemi(); out.consts.push({ type, name, tokens: tokens.slice(start, i - 1) }); continue } }
      i = save; skipToSemi(); continue
    }
    skipQual()
    // function or global var:  TYPE name ( ... ) { ... }   OR  TYPE name ... ;
    if (peek().k === 'type' || (peek().k === 'id' && STRUCTS[peek().v])) {
      const ret = eat().v
      if (peek().k !== 'id') { skipToSemi(); continue }
      const name = eat().v
      if (at('op', '(')) {
        // params
        eat(); const params = []
        if (!at('op', ')')) {
          for (; ;) {
            let qual = ''
            while (at('kw', 'in') || at('kw', 'out') || at('kw', 'inout') || at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'const')) { if (tokens[i].v === 'out' || tokens[i].v === 'inout') qual = tokens[i].v; i++ }
            const ptype = eat().v; const pname = eat().v
            params.push({ type: ptype, name: pname, out: qual === 'out' || qual === 'inout' })
            if (at('op', ',')) { eat(); continue }
            break
          }
        }
        if (!at('op', ')')) throw new Error('expected ) in params of ' + name)
        eat()
        if (at('op', '{')) { const bodyTokens = matchBrace(); out.fns.push({ ret, name, params, bodyTokens }) }
        else { skipToSemi() }   // forward declaration
        continue
      }
      skipToSemi(); continue
    }
    // anything else: skip a token (defensive)
    i++
  }
  return out
}

// ---------- 4. expression + statement codegen (per function) ----------
const BUILTIN = new Set(['floor', 'ceil', 'abs', 'fract', 'sign', 'sqrt', 'sin', 'cos', 'tan', 'exp', 'tanh', 'pow', 'min', 'max', 'mod', 'clamp', 'mix', 'smoothstep', 'step', 'dot', 'length', 'distance', 'normalize', 'cross', 'float', 'int'])
const VEC_BUILTIN = new Set(['vec2', 'vec3', 'vec4', 'mat3', 'ivec2', 'ivec3', 'uvec2', 'uvec3'])
const COMP_RANK = { float: 1, int: 1, uint: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 }
const isVecT = (t) => t === 'vec2' || t === 'vec3' || t === 'vec4'

function genFunction(fn, fnReturnTypes) {
  const toks = fn.bodyTokens; let i = 0
  const types = new Map()   // var name -> glsl type
  for (const p of fn.params) types.set(p.name, p.type)
  const outParams = fn.params.filter(p => p.out)
  const at = (k, v) => toks[i] && toks[i].k === k && (v === undefined || toks[i].v === v)
  const peek = (o = 0) => toks[i + o] || { k: 'eof', v: '' }
  const eat = () => toks[i++]
  const expect = (v) => { if (!at('op', v) && !at('kw', v)) throw new Error(`[${fn.name}] expected ${v}, got ${JSON.stringify(peek())}`); return eat() }

  // ---- expression parser (returns {js, type}) ----
  // precedence climbing
  const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 }
  function parseExpr(minPrec = 0) {
    let lhs = parseUnary()
    for (; ;) {
      if (!at('op')) break
      const op = peek().v
      // ternary handled separately at the top
      if (op === '?') {
        if (minPrec > 0) break
        eat(); const t = parseExpr(0); expect(':'); const f = parseExpr(0)
        const rt = t.type !== 'float' ? t.type : f.type
        lhs = { js: `(${lhs.js} ? ${t.js} : ${f.js})`, type: rt }
        continue
      }
      const p = PREC[op]; if (p === undefined || p < minPrec) break
      eat(); const rhs = parseExpr(p + 1)
      lhs = binOp(op, lhs, rhs)
    }
    return lhs
  }
  function binOp(op, a, b) {
    const av = isVecT(a.type), bv = isVecT(b.type)
    const resVec = av ? a.type : bv ? b.type : null
    if (op === '+' || op === '-' || op === '*' || op === '/') {
      if (av || bv) {
        // mat3 * vec3
        if (a.type === 'mat3' && isVecT(b.type)) return { js: `g.mat3mul(${a.js}, ${b.js})`, type: b.type }
        const fn = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[op]
        return { js: `g.${fn}(${a.js}, ${b.js})`, type: resVec }
      }
      // scalar arithmetic; '/' on ints in GLSL is int div but height uses float ctx -> keep JS '/'
      return { js: `(${a.js} ${op} ${b.js})`, type: 'float' }
    }
    if (op === '%') return { js: `g.mod(${a.js}, ${b.js})`, type: av || bv ? resVec : 'float' }
    if (op === '<<') return { js: `g.ushl(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '>>') return { js: `g.ushr(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '&') return { js: `g.uand(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '|') return { js: `g.uor(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '^') return { js: `g.uxor(${a.js}, ${b.js})`, type: 'uint' }
    // comparison / logical -> native JS (operands are scalars in this subset)
    return { js: `(${a.js} ${op} ${b.js})`, type: 'bool' }
  }
  function parseUnary() {
    if (at('op', '-')) { eat(); const u = parseUnary(); return { js: isVecT(u.type) ? `g.neg(${u.js})` : `(-${u.js})`, type: u.type } }
    if (at('op', '+')) { eat(); return parseUnary() }
    if (at('op', '!')) { eat(); const u = parseUnary(); return { js: `(!${u.js})`, type: 'bool' } }
    return parsePostfix()
  }
  function parsePostfix() {
    let e = parsePrimary()
    for (; ;) {
      if (at('op', '.')) {
        eat(); const sel = eat().v
        // struct field or swizzle
        if (e.type in STRUCTS || (STRUCTS[e.type])) {
          e = { js: `${e.js}.${sel}`, type: structFieldType(e.type, sel) }
        } else if ((isVecT(e.type) || /^[ui]vec[234]$/.test(e.type)) && /^[xyzwrgbastpq]+$/.test(sel)) {
          if (sel.length === 1) e = { js: `g.sw(${e.js}, '${sel}')`, type: /^[ui]vec/.test(e.type) ? 'uint' : 'float' }
          else e = { js: `g.sw(${e.js}, '${sel}')`, type: 'vec' + sel.length }
        } else throw new Error(`[${fn.name}] bad member .${sel} on ${e.type}`)
      } else break
    }
    return e
  }
  function structFieldType(stype, field) {
    // find the struct decl
    const sd = ALL_STRUCTS.find(s => s.name === stype)
    if (sd) { const f = sd.fields.find(x => x.name === field); if (f) return f.type }
    return 'float'
  }
  function parsePrimary() {
    if (at('op', '(')) { eat(); const e = parseExpr(0); expect(')'); return e }
    if (at('num')) { let v = eat().v; const isU = /[uU]$/.test(v); if (isU) v = v.slice(0, -1); if (/^0[xX]/.test(v)) return { js: v, type: 'uint' }; return { js: v, type: isU ? 'uint' : /[.eE]/.test(v) ? 'float' : 'float' } }
    if (at('kw', 'true')) { eat(); return { js: 'true', type: 'bool' } }
    if (at('kw', 'false')) { eat(); return { js: 'false', type: 'bool' } }
    if (at('type') || at('id')) {
      const name = eat().v
      if (at('op', '(')) return parseCall(name)
      // variable / uniform
      if (UNIFORMS.has(name)) return { js: `U.${name}`, type: uniformType(name) }
      const t = types.get(name)
      if (t === undefined) {
        // unknown identifier referenced -> likely a uniform we missed or a global const
        if (CONST_TYPES[name]) return { js: `C_${name}`, type: CONST_TYPES[name] }
        throw new Error(`[${fn.name}] unknown identifier '${name}'`)
      }
      return { js: jsVar(name), type: t }
    }
    throw new Error(`[${fn.name}] unexpected token in expr: ${JSON.stringify(peek())}`)
  }
  function parseCall(name) {
    expect('(')
    const args = []
    if (!at('op', ')')) { for (; ;) { args.push(parseExpr(0)); if (at('op', ',')) { eat(); continue } break } }
    expect(')')
    // constructors
    if (VEC_BUILTIN.has(name)) return { js: `g.${name}(${args.map(a => a.js).join(', ')})`, type: name }
    if (BUILTIN.has(name)) {
      const t = (name === 'dot' || name === 'length' || name === 'distance' || name === 'float' || name === 'int') ? 'float'
        : (name === 'normalize' || name === 'cross') ? (args[0] ? args[0].type : 'vec3')
        : (args.find(a => isVecT(a.type))?.type || 'float')
      return { js: `g.${name}(${args.map(a => a.js).join(', ')})`, type: t }
    }
    if (STRUCTS[name]) {   // struct constructor HCache(...)
      const fields = STRUCTS[name]
      return { js: `{ ${fields.map((f, k) => `${f}: ${args[k].js}`).join(', ')} }`, type: name }
    }
    // user function call -- handle out-params
    const callee = ALL_FNS.find(f => f.name === name && f.params.length === args.length)
    if (callee && callee.params.some(p => p.out)) {
      // value + out-params returned as array [ret, out1, out2...]; here used as expression -> take [0]
      return { js: `${name}(${args.filter((_, k) => !callee.params[k].out).map(a => a.js).join(', ')})[0]`, type: fnReturnTypes[name] || 'float' }
    }
    return { js: `${name}(${args.map(a => a.js).join(', ')})`, type: fnReturnTypes[name] || 'float' }
  }
  function uniformType(n) { return /Octs|Max$/.test(n) || n === 'uVsCheap' ? 'float' : 'float' }

  // ---- statement parser ----
  const lines = []
  const pad = (d) => '  '.repeat(d)
  function genBlock(depth) {
    expect('{')
    while (!at('op', '}')) genStatement(depth)
    expect('}')
  }
  function genStatement(depth) {
    if (at('op', '{')) { lines.push(pad(depth) + '{'); genBlock0(depth + 1); lines.push(pad(depth) + '}'); return }
    if (at('kw', 'return')) { eat(); if (at('op', ';')) { eat(); lines.push(pad(depth) + emitReturn(null)); return } const e = parseExpr(0); expect(';'); lines.push(pad(depth) + emitReturn(e)); return }
    if (at('kw', 'if')) { eat(); expect('('); const c = parseExpr(0); expect(')'); lines.push(pad(depth) + `if (${c.js}) {`); genStmtOrBlock(depth + 1); lines.push(pad(depth) + '}'); if (at('kw', 'else')) { eat(); lines.push(pad(depth) + 'else {'); genStmtOrBlock(depth + 1); lines.push(pad(depth) + '}') } return }
    if (at('kw', 'for')) { eat(); expect('('); const init = genForInit(); expect(';'); const cond = parseExpr(0); expect(';'); const upd = genForUpdate(); expect(')'); lines.push(pad(depth) + `for (${init}; ${cond.js}; ${upd}) {`); genStmtOrBlock(depth + 1); lines.push(pad(depth) + '}'); return }
    if (at('kw', 'break')) { eat(); expect(';'); lines.push(pad(depth) + 'break;'); return }
    if (at('kw', 'continue')) { eat(); expect(';'); lines.push(pad(depth) + 'continue;'); return }
    // declaration?  (qual)* TYPE name (= expr)? (, name (=expr)?)* ;
    let save = i; let q = false
    while (at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'const')) { q = true; i++ }
    if (at('type') || (at('id') && STRUCTS[peek().v])) {
      const declType = eat().v
      if (at('id')) {
        // one or more declarators
        for (; ;) {
          const vname = eat().v; types.set(vname, declType)
          let init = ''
          if (at('op', '=')) { eat(); const e = parseExpr(0); init = ' = ' + coerce(e, declType) }
          else init = ' = ' + defaultInit(declType)
          lines.push(pad(depth) + `let ${jsVar(vname)}${init};`)
          if (at('op', ',')) { eat(); continue } break
        }
        expect(';'); return
      }
      i = save   // not a decl, rewind
    } else i = save
    // expression statement / assignment
    const target = parseLValue()
    if (at('op', '=') || at('op', '+=') || at('op', '-=') || at('op', '*=') || at('op', '/=') || at('op', '^=')) {
      const op = eat().v; const rhs = parseExpr(0); expect(';')
      lines.push(pad(depth) + emitAssign(target, op, rhs))
      return
    }
    // bare call (out-param producing) or expr
    expect(';')
    lines.push(pad(depth) + emitBareCall(target) + ';')
  }
  function genStmtOrBlock(depth) { if (at('op', '{')) { genBlock0(depth) } else genStatement(depth) }
  function genBlock0(depth) { expect('{'); while (!at('op', '}')) genStatement(depth); expect('}') }
  function genForInit() {
    // int o = 0
    while (at('kw', 'highp') || at('kw', 'const')) i++
    if (at('type')) { const t = eat().v; const n = eat().v; types.set(n, t); expect('='); const e = parseExpr(0); return `let ${jsVar(n)} = ${e.js}` }
    const lv = parseLValue(); expect('='); const e = parseExpr(0); return `${lvJs(lv)} = ${e.js}`
  }
  function genForUpdate() {
    // o++  / o += 1
    const lv = parseLValue()
    if (at('op', '++')) { eat(); return `${lvJs(lv)}++` }
    if (at('op', '--')) { eat(); return `${lvJs(lv)}--` }
    if (at('op', '+=') || at('op', '-=') || at('op', '*=') || at('op', '/=')) { const op = eat().v; const e = parseExpr(0); return `${lvJs(lv)} ${op} ${e.js}` }
    return lvJs(lv)
  }
  // lvalue: name(.swizzle)?  -- supports `o`, `sum`, `e.x` (vec component assign)
  function parseLValue() {
    const name = eat().v
    let sel = null
    if (at('op', '.')) { eat(); sel = eat().v }
    if (at('op', '(')) { // it was actually a call statement
      i -= (sel ? 3 : 1) // rewind name (and .sel)
      const e = parseExpr(0)
      return { call: e }
    }
    return { name, sel, type: types.get(name) }
  }
  function lvJs(lv) { if (lv.sel) return `${jsVar(lv.name)}[${swIndex(lv.sel)}]`; return jsVar(lv.name) }
  function emitAssign(target, op, rhs) {
    if (target.call) throw new Error(`[${fn.name}] assignment to call`)
    const tt = target.sel ? 'float' : target.type
    if (op === '=') return `${lvJs(target)} = ${coerce(rhs, tt)};`
    // compound: vec += vec/scalar
    const baseOp = op[0]
    if (isVecT(tt) || isVecT(rhs.type)) { const f = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[baseOp]; return `${lvJs(target)} = g.${f}(${lvJs(target)}, ${rhs.js});` }
    return `${lvJs(target)} ${op} ${rhs.js};`
  }
  function emitBareCall(target) {
    if (target.call) {
      // a value-discarding call (rare). If it has out-params used elsewhere it'd be an assign; here just emit.
      return target.call.js
    }
    return jsVar(target.name)
  }
  // a statement-level call with out-params:  `foo(a, outVar);`  -> `[, outVar] = foo(a)`  -- handled where it appears as a decl-init form `T x; foo(d, x)`. In this GLSL the out form is always `T outv; fn(args..., outv)` then used. We detect at the call: see parseStatement's expr path.

  function emitReturn(e) {
    if (e === null) return 'return;'
    if (outParams.length) {
      // return [value, out1, out2...]
      return `return [${coerce(e, fn.ret)}, ${outParams.map(p => jsVar(p.name)).join(', ')}];`
    }
    return `return ${coerce(e, fn.ret)};`
  }
  function coerce(e, targetType) {
    if (targetType === 'float' && e.type === 'int') return e.js   // numbers in JS
    return e.js
  }
  function defaultInit(t) { return (isVecT(t) || VEC_BUILTIN.has(t)) ? `g.${t}(0)` : (t in STRUCTS ? 'null' : '0') }

  // generate the body
  while (i < toks.length) genStatement(1)

  // assemble JS function. out-params: declared as locals at top, returned in the array.
  const inParams = fn.params.filter(p => !p.out).map(p => jsVar(p.name))
  let head = `function ${fn.name}(${inParams.join(', ')}) {`
  if (outParams.length) {
    // ensure out locals exist (the GLSL caller passes them; here they are local + returned)
    const decls = outParams.map(p => `  let ${jsVar(p.name)} = ${isVecT(p.type) ? `g.${p.type}(0)` : '0'};`).join('\n')
    head += '\n' + decls
  }
  return head + '\n' + lines.join('\n') + '\n}'
}

function jsVar(n) { return n === 'g' || n === 'U' || n === 'C' ? '_' + n : n }
function swIndex(sel) { return { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 }[sel] }

// ---------- 5. drive ----------
const tokens = tokenize(CODE)
const TOP = sliceTopLevel(tokens)
const ALL_STRUCTS = TOP.structs
const ALL_FNS = TOP.fns
const CONST_TYPES = {}; for (const c of TOP.consts) CONST_TYPES[c.name] = c.type

// build return-type map
const fnReturnTypes = {}; for (const f of ALL_FNS) fnReturnTypes[f.name] = f.ret

// emit consts (OCT_ROT etc.) referenced by the height fns (+ transitive deps from const initializers)
const _wantConstsBase = TOP.consts.filter(c => HEIGHT_FNS.some(n => ALL_FNS.find(f => f.name === n && f.bodyTokens.some(t => t.v === c.name))))
const wantConstsSet = new Set(_wantConstsBase.map(c => c.name))
// transitive: consts referenced inside the initializer tokens of already-wanted consts
let changed = true
while (changed) { changed = false; for (const c of TOP.consts) { if (wantConstsSet.has(c.name)) { for (const tok of c.tokens) { const dep = TOP.consts.find(d => d.name === tok.v); if (dep && !wantConstsSet.has(dep.name)) { wantConstsSet.add(dep.name); changed = true } } } } }
const wantConsts = TOP.consts.filter(c => wantConstsSet.has(c.name))
const constJs = wantConsts.map(c => {
  // const is a literal expression; transpile via a mini gen
  const fake = { name: '_const_' + c.name, params: [], bodyTokens: [...c.tokens, { k: 'op', v: ';' }], ret: c.type }
  // simplest: handle mat3(...) / vecN(...) constructor literal
  const sub = tokenize(c.tokens.map(t => t.v).join(' '))
  // reuse expression parser via a tiny wrapper
  const e = parseConstExpr(c.tokens, c.type)
  return `const C_${c.name} = ${e};`
}).join('\n')

function parseConstExpr(toks, type) {
  // only need: mat3( numbers ), vecN( numbers ), struct( args ), or a number/const-ref
  let i = 0
  function val() {
    const t = toks[i]
    // vec/mat constructor (built-in type)
    if (t.k === 'type' && (t.v === 'mat3' || /^vec/.test(t.v))) { const name = toks[i++].v; if (toks[i].v !== '(') throw 0; i++; const args = []; while (toks[i].v !== ')') { if (toks[i].v === ',') { i++; continue } args.push(val()) } i++; return `g.${name}(${args.join(', ')})` }
    // struct constructor: id '('
    if (t.k === 'id' && STRUCTS[t.v] && toks[i + 1] && toks[i + 1].v === '(') {
      const sname = toks[i++].v; i++ // skip '('
      const fields = STRUCTS[sname]; const args = []; let fi = 0
      while (toks[i].v !== ')') { if (toks[i].v === ',') { i++; continue } args.push(val()); fi++ } i++
      return `{ ${fields.map((f, k) => `${f}: ${args[k]}`).join(', ')} }`
    }
    // const reference (e.g. LTYPE_FBM)
    if (t.k === 'id' && CONST_TYPES[t.v]) { i++; return `C_${t.v}` }
    return numTok()
  }
  function numTok() { let s = ''; if (toks[i].v === '-') { s = '-'; i++ } const v = toks[i++].v; return s + v }
  return val()
}

// generate each wanted fn (dedupe overloads by emitting the LAST def matching name+arity used; for
// the height path we emit a single JS fn per name -- the multi-arg out version, plus the value-only
// overload is inlined by callers via [0]).
const want = []
for (const name of HEIGHT_FNS) {
  const defs = ALL_FNS.filter(f => f.name === name)
  if (!defs.length) throw new Error('height fn not found in GLSL: ' + name)
  // pick the def with the MOST params (the out-param-bearing canonical one)
  const def = defs.reduce((a, b) => (b.params.length > a.params.length ? b : a))
  want.push(genFunction(def, fnReturnTypes))
}
// STUB_FNS: fail loud if the GLSL declaration this stub is standing in for has been removed
// (a stub outliving its own justification is exactly the silent-divergence class this generator
// exists to prevent) -- and if it has been REPLACED with something that no longer touches a
// texture, that's a signal the stub should probably become a real transpiled HEIGHT_FNS entry
// instead, so this stays a loud error, not a quiet auto-fix.
for (const name of Object.keys(STUB_FNS)) {
  if (!ALL_FNS.some(f => f.name === name)) throw new Error('STUB_FNS[' + name + '] has no matching GLSL declaration -- remove the stub or the GLSL call site')
}
const stubJs = Object.entries(STUB_FNS).map(([name, { params, body }]) => `function ${name}(${params.join(', ')}) { return ${body}; }`)

const header = `// GENERATED by scripts/gen-height.mjs from src/shaders/terrain.glsl -- DO NOT EDIT.
// The GLSL is the single source of truth; re-run \`node scripts/gen-height.mjs\` after editing
// the terrain HEIGHT functions. \`g\` = the GLSL runtime shim (glsl-rt.js); \`U\` = uniform values;
// hpfSample is supplied by the caller (the pure-JS anchor-field) via the U/ctx closure.
// GPU-texture-only calls reachable from a transpiled height fn (sculptOverrideAt etc, see
// STUB_FNS in gen-height.mjs) are emitted below as fixed-value stubs, not transpiled.
import * as g from './glsl-rt.js';
`

const out = header + '\nexport function makeHeight(U, hpfSample) {\n' +
  constJs.split('\n').filter(Boolean).map(l => '  ' + l).join('\n') + '\n' +
  stubJs.map(l => '  ' + l).join('\n') + (stubJs.length ? '\n' : '') +
  want.map(w => w.split('\n').map(l => '  ' + l).join('\n')).join('\n\n') + '\n' +
  '\n  return { snoise3, composeHeight, continentalBias };\n}\n'

writeFileSync(join(ROOT, 'src/height-gen.js'), out)
console.log('[gen-height] wrote src/height-gen.js (' + want.length + ' fns, ' + out.length + ' bytes)')
