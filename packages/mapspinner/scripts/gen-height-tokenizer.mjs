// GLSL tokenizer used by gen-height.mjs's transpile pipeline -- pure, stateless (no reference to any
// module-level parser/codegen state), extracted as the one genuinely separable piece of that file.

export const KW = new Set(['if', 'else', 'for', 'while', 'return', 'const', 'struct', 'in', 'out', 'inout', 'highp', 'mediump', 'lowp', 'precision', 'uniform', 'attribute', 'varying', 'flat', 'break', 'continue', 'true', 'false'])
export const TYPES = new Set(['void', 'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'uvec2', 'uvec3', 'mat2', 'mat3', 'mat4'])

export function tokenize(s) {
  const t = []
  let i = 0
  const re = {
    ws: /\s+/y, num: /\d+\.\d+([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|\d+\.?([eE][+-]?\d+)?[uU]?|0[xX][0-9a-fA-F]+[uU]?/y,
    id: /[A-Za-z_]\w*/y,
    op: /\^=|\+=|-=|\*=|\/=|%=|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[-+*/%<>=!&|^~?:.,;(){}\[\]]/y,
  }
  while (i < s.length) {
    re.ws.lastIndex = i; let m = re.ws.exec(s); if (m && m.index === i) { i = re.ws.lastIndex; continue }
    re.num.lastIndex = i; m = re.num.exec(s); if (m && m.index === i) { t.push({ k: 'num', v: m[0] }); i = re.num.lastIndex; continue }
    re.id.lastIndex = i; m = re.id.exec(s); if (m && m.index === i) { const v = m[0]; t.push({ k: KW.has(v) ? 'kw' : TYPES.has(v) ? 'type' : 'id', v }); i = re.id.lastIndex; continue }
    re.op.lastIndex = i; m = re.op.exec(s); if (m && m.index === i) { t.push({ k: 'op', v: m[0] }); i = re.op.lastIndex; continue }
    throw new Error('tokenize: unexpected char at ' + i + ': ' + JSON.stringify(s.slice(i, i + 20)))
  }
  t.push({ k: 'eof', v: '' })
  return t
}

export function strip(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  s = s.replace(/^[ \t]*#[^\n]*$/gm, ' ')   // drop #ifdef/#endif/#version/#define lines
  return s
}
