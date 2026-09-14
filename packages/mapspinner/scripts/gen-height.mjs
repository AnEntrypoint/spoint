#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { strip, tokenize } from './gen-height-tokenizer.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'src/shaders/terrain.glsl'), 'utf8')

const HEIGHT_FNS = [
  'h3', 'snoise3',
  'value_fbm', 'value_fbm_scaled',
  'rotate_domain', 'value_ridged_fbm_rot', 'value_ridged_fbm_rot_scaled',
  'eval_layer', 'sample_fractal_terrain',
  'fractalTerrainH', 'vhash', 'vnoise2', 'faceWarp',
  'composeHeight', 'continentalBias',
]
const STUB_FNS = {
  sculptOverrideAt: { params: ['dir0', 'hBase'], body: '0.0' },
}
const UNIFORMS = new Set([
  'uLandBias', 'uBeachShelfM', 'canyonDepthMul', 'uDetailOverlay', 'uHiFreqCut', 'uCarveWide',
  'uMtnBandWide', 'uClimateRelief', 'uIsleWide', 'uVsCheap', 'cliffAmt', 'vtxDetail', 'defRadius',
  'uOctMax', 'uInciseRidgeOcts', 'uBroadLowOcts', 'uPeakOcts', 'uDetailFbmOcts', 'uVtxBaseOcts', 'uVtxErodeOcts',
  'uNoUnroll',
])
const STRUCTS = {}

const CODE = strip(SRC)

function sliceTopLevel(tokens) {
  const out = { structs: [], consts: [], fns: [] }
  let i = 0
  const peek = () => tokens[i], at = (k, v) => tokens[i].k === k && (v === undefined || tokens[i].v === v)
  const eat = () => tokens[i++]
  const skipQual = () => { while (at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'const') || at('kw', 'flat')) i++ }
  function matchBrace() {
    if (!at('op', '{')) throw new Error('expected {')
    const start = ++i; let d = 1
    while (d > 0) { if (at('op', '{')) d++; else if (at('op', '}')) d--; if (tokens[i].k === 'eof') throw new Error('unbalanced {'); i++ }
    return tokens.slice(start, i - 1)
  }
  function skipToSemi() { while (!at('op', ';') && tokens[i].k !== 'eof') i++; if (at('op', ';')) i++ }
  while (tokens[i].k !== 'eof') {
    if (at('kw', 'uniform')) { eat(); while (at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'flat')) i++; if (peek().k === 'type' || peek().k === 'id') i++; if (peek().k === 'id') UNIFORMS.add(peek().v); skipToSemi(); continue }
    if (at('kw', 'varying') || at('kw', 'attribute') || at('kw', 'precision') || at('kw', 'in') || at('kw', 'out') || at('kw', 'flat')) { skipToSemi(); continue }
    if (at('kw', 'struct')) {
      eat(); const name = eat().v; const fields = []
      const body = matchBrace()
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
    if (at('kw', 'const')) {
      const save = i; eat(); skipQual(); if (peek().k === 'type' || (peek().k === 'id' && STRUCTS[peek().v])) { const type = eat().v; const name = eat().v; if (at('op', '=')) { eat(); const start = i; skipToSemi(); out.consts.push({ type, name, tokens: tokens.slice(start, i - 1) }); continue } }
      i = save; skipToSemi(); continue
    }
    skipQual()
    if (peek().k === 'type' || (peek().k === 'id' && STRUCTS[peek().v])) {
      const ret = eat().v
      if (peek().k !== 'id') { skipToSemi(); continue }
      const name = eat().v
      if (at('op', '(')) {
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
        else { skipToSemi() }
        continue
      }
      skipToSemi(); continue
    }
    i++
  }
  return out
}

const BUILTIN = new Set(['floor', 'ceil', 'abs', 'fract', 'sign', 'sqrt', 'sin', 'cos', 'tan', 'exp', 'tanh', 'pow', 'min', 'max', 'mod', 'clamp', 'mix', 'smoothstep', 'step', 'dot', 'length', 'distance', 'normalize', 'cross', 'float', 'int'])
const VEC_BUILTIN = new Set(['vec2', 'vec3', 'vec4', 'mat3', 'ivec2', 'ivec3', 'uvec2', 'uvec3'])
const COMP_RANK = { float: 1, int: 1, uint: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 }
const isVecT = (t) => t === 'vec2' || t === 'vec3' || t === 'vec4'

function genFunction(fn, fnReturnTypes) {
  const toks = fn.bodyTokens; let i = 0
  const types = new Map()
  for (const p of fn.params) types.set(p.name, p.type)
  const outParams = fn.params.filter(p => p.out)
  const at = (k, v) => toks[i] && toks[i].k === k && (v === undefined || toks[i].v === v)
  const peek = (o = 0) => toks[i + o] || { k: 'eof', v: '' }
  const eat = () => toks[i++]
  const expect = (v) => { if (!at('op', v) && !at('kw', v)) throw new Error(`[${fn.name}] expected ${v}, got ${JSON.stringify(peek())}`); return eat() }

  const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 }
  function parseExpr(minPrec = 0) {
    let lhs = parseUnary()
    for (; ;) {
      if (!at('op')) break
      const op = peek().v
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
        if (a.type === 'mat3' && isVecT(b.type)) return { js: `g.mat3mul(${a.js}, ${b.js})`, type: b.type }
        const fn = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[op]
        return { js: `g.${fn}(${a.js}, ${b.js})`, type: resVec }
      }
      return { js: `(${a.js} ${op} ${b.js})`, type: 'float' }
    }
    if (op === '%') return { js: `g.mod(${a.js}, ${b.js})`, type: av || bv ? resVec : 'float' }
    if (op === '<<') return { js: `g.ushl(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '>>') return { js: `g.ushr(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '&') return { js: `g.uand(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '|') return { js: `g.uor(${a.js}, ${b.js})`, type: 'uint' }
    if (op === '^') return { js: `g.uxor(${a.js}, ${b.js})`, type: 'uint' }
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
      if (UNIFORMS.has(name)) return { js: `U.${name}`, type: uniformType(name) }
      const t = types.get(name)
      if (t === undefined) {
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
    if (VEC_BUILTIN.has(name)) return { js: `g.${name}(${args.map(a => a.js).join(', ')})`, type: name }
    if (BUILTIN.has(name)) {
      const t = (name === 'dot' || name === 'length' || name === 'distance' || name === 'float' || name === 'int') ? 'float'
        : (name === 'normalize' || name === 'cross') ? (args[0] ? args[0].type : 'vec3')
        : (args.find(a => isVecT(a.type))?.type || 'float')
      return { js: `g.${name}(${args.map(a => a.js).join(', ')})`, type: t }
    }
    if (STRUCTS[name]) {
      const fields = STRUCTS[name]
      return { js: `{ ${fields.map((f, k) => `${f}: ${args[k].js}`).join(', ')} }`, type: name }
    }
    const callee = ALL_FNS.find(f => f.name === name && f.params.length === args.length)
    if (callee && callee.params.some(p => p.out)) {
      return { js: `${name}(${args.filter((_, k) => !callee.params[k].out).map(a => a.js).join(', ')})[0]`, type: fnReturnTypes[name] || 'float' }
    }
    return { js: `${name}(${args.map(a => a.js).join(', ')})`, type: fnReturnTypes[name] || 'float' }
  }
  function uniformType(n) { return /Octs|Max$/.test(n) || n === 'uVsCheap' ? 'float' : 'float' }

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
    let save = i; let q = false
    while (at('kw', 'highp') || at('kw', 'mediump') || at('kw', 'lowp') || at('kw', 'const')) { q = true; i++ }
    if (at('type') || (at('id') && STRUCTS[peek().v])) {
      const declType = eat().v
      if (at('id')) {
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
      i = save
    } else i = save
    const target = parseLValue()
    if (at('op', '=') || at('op', '+=') || at('op', '-=') || at('op', '*=') || at('op', '/=') || at('op', '^=')) {
      const op = eat().v; const rhs = parseExpr(0); expect(';')
      lines.push(pad(depth) + emitAssign(target, op, rhs))
      return
    }
    expect(';')
    lines.push(pad(depth) + emitBareCall(target) + ';')
  }
  function genStmtOrBlock(depth) { if (at('op', '{')) { genBlock0(depth) } else genStatement(depth) }
  function genBlock0(depth) { expect('{'); while (!at('op', '}')) genStatement(depth); expect('}') }
  function genForInit() {
    while (at('kw', 'highp') || at('kw', 'const')) i++
    if (at('type')) { const t = eat().v; const n = eat().v; types.set(n, t); expect('='); const e = parseExpr(0); return `let ${jsVar(n)} = ${e.js}` }
    const lv = parseLValue(); expect('='); const e = parseExpr(0); return `${lvJs(lv)} = ${e.js}`
  }
  function genForUpdate() {
    const lv = parseLValue()
    if (at('op', '++')) { eat(); return `${lvJs(lv)}++` }
    if (at('op', '--')) { eat(); return `${lvJs(lv)}--` }
    if (at('op', '+=') || at('op', '-=') || at('op', '*=') || at('op', '/=')) { const op = eat().v; const e = parseExpr(0); return `${lvJs(lv)} ${op} ${e.js}` }
    return lvJs(lv)
  }
  function parseLValue() {
    const name = eat().v
    let sel = null
    if (at('op', '.')) { eat(); sel = eat().v }
    if (at('op', '(')) {
      i -= (sel ? 3 : 1)
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
    const baseOp = op[0]
    if (isVecT(tt) || isVecT(rhs.type)) { const f = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[baseOp]; return `${lvJs(target)} = g.${f}(${lvJs(target)}, ${rhs.js});` }
    return `${lvJs(target)} ${op} ${rhs.js};`
  }
  function emitBareCall(target) {
    if (target.call) {
      return target.call.js
    }
    return jsVar(target.name)
  }

  function emitReturn(e) {
    if (e === null) return 'return;'
    if (outParams.length) {
      return `return [${coerce(e, fn.ret)}, ${outParams.map(p => jsVar(p.name)).join(', ')}];`
    }
    return `return ${coerce(e, fn.ret)};`
  }
  function coerce(e, targetType) {
    if (targetType === 'float' && e.type === 'int') return e.js
    return e.js
  }
  function defaultInit(t) { return (isVecT(t) || VEC_BUILTIN.has(t)) ? `g.${t}(0)` : (t in STRUCTS ? 'null' : '0') }

  while (i < toks.length) genStatement(1)

  const inParams = fn.params.filter(p => !p.out).map(p => jsVar(p.name))
  let head = `function ${fn.name}(${inParams.join(', ')}) {`
  if (outParams.length) {
    const decls = outParams.map(p => `  let ${jsVar(p.name)} = ${isVecT(p.type) ? `g.${p.type}(0)` : '0'};`).join('\n')
    head += '\n' + decls
  }
  return head + '\n' + lines.join('\n') + '\n}'
}

function jsVar(n) { return n === 'g' || n === 'U' || n === 'C' ? '_' + n : n }
function swIndex(sel) { return { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 }[sel] }

const tokens = tokenize(CODE)
const TOP = sliceTopLevel(tokens)
const ALL_STRUCTS = TOP.structs
const ALL_FNS = TOP.fns
const CONST_TYPES = {}; for (const c of TOP.consts) CONST_TYPES[c.name] = c.type

const fnReturnTypes = {}; for (const f of ALL_FNS) fnReturnTypes[f.name] = f.ret

const _wantConstsBase = TOP.consts.filter(c => HEIGHT_FNS.some(n => ALL_FNS.find(f => f.name === n && f.bodyTokens.some(t => t.v === c.name))))
const wantConstsSet = new Set(_wantConstsBase.map(c => c.name))
let changed = true
while (changed) { changed = false; for (const c of TOP.consts) { if (wantConstsSet.has(c.name)) { for (const tok of c.tokens) { const dep = TOP.consts.find(d => d.name === tok.v); if (dep && !wantConstsSet.has(dep.name)) { wantConstsSet.add(dep.name); changed = true } } } } }
const wantConsts = TOP.consts.filter(c => wantConstsSet.has(c.name))
const constJs = wantConsts.map(c => {
  const fake = { name: '_const_' + c.name, params: [], bodyTokens: [...c.tokens, { k: 'op', v: ';' }], ret: c.type }
  const sub = tokenize(c.tokens.map(t => t.v).join(' '))
  const e = parseConstExpr(c.tokens, c.type)
  return `const C_${c.name} = ${e};`
}).join('\n')

function parseConstExpr(toks, type) {
  let i = 0
  function val() {
    const t = toks[i]
    if (t.k === 'type' && (t.v === 'mat3' || /^vec/.test(t.v))) { const name = toks[i++].v; if (toks[i].v !== '(') throw 0; i++; const args = []; while (toks[i].v !== ')') { if (toks[i].v === ',') { i++; continue } args.push(val()) } i++; return `g.${name}(${args.join(', ')})` }
    if (t.k === 'id' && STRUCTS[t.v] && toks[i + 1] && toks[i + 1].v === '(') {
      const sname = toks[i++].v; i++
      const fields = STRUCTS[sname]; const args = []; let fi = 0
      while (toks[i].v !== ')') { if (toks[i].v === ',') { i++; continue } args.push(val()); fi++ } i++
      return `{ ${fields.map((f, k) => `${f}: ${args[k]}`).join(', ')} }`
    }
    if (t.k === 'id' && CONST_TYPES[t.v]) { i++; return `C_${t.v}` }
    return numTok()
  }
  function numTok() { let s = ''; if (toks[i].v === '-') { s = '-'; i++ } const v = toks[i++].v; return s + v }
  return val()
}

const want = []
for (const name of HEIGHT_FNS) {
  const defs = ALL_FNS.filter(f => f.name === name)
  if (!defs.length) throw new Error('height fn not found in GLSL: ' + name)
  const def = defs.reduce((a, b) => (b.params.length > a.params.length ? b : a))
  want.push(genFunction(def, fnReturnTypes))
}
for (const name of Object.keys(STUB_FNS)) {
  if (!ALL_FNS.some(f => f.name === name)) throw new Error('STUB_FNS[' + name + '] has no matching GLSL declaration -- remove the stub or the GLSL call site')
}
const stubJs = Object.entries(STUB_FNS).map(([name, { params, body }]) => `function ${name}(${params.join(', ')}) { return ${body}; }`)

const header = `import * as g from './glsl-rt.js';
`

const out = header + '\nexport function makeHeight(U, hpfSample) {\n' +
  constJs.split('\n').filter(Boolean).map(l => '  ' + l).join('\n') + '\n' +
  stubJs.map(l => '  ' + l).join('\n') + (stubJs.length ? '\n' : '') +
  want.map(w => w.split('\n').map(l => '  ' + l).join('\n')).join('\n\n') + '\n' +
  '\n  return { snoise3, composeHeight, continentalBias };\n}\n'

writeFileSync(join(ROOT, 'src/height-gen.js'), out)
console.log('[gen-height] wrote src/height-gen.js (' + want.length + ' fns, ' + out.length + ' bytes)')
