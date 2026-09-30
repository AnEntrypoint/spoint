import { Fn, Loop, If, float, int, uint, ivec2, uvec2, vec2, mix, abs, sin, cos, pow, floor } from 'three/tsl'

export const SEA_OCTAVES = 8
const SEA_FREQ = 0.2
const SEA_SPEED = 2.4
const SEA_AMP_M = 0.6
const SEA_OCTAVE_ANGLE = 1.57079633
const SEA_FREQ_LF = 0.16

const layout = (name, type, inputs, body) => Fn((a) => body(...a)).setLayout({ name, type, inputs: inputs.map(([n, t]) => ({ name: n, type: t })) })

const seaHash = layout('seaHash', 'float', [['p', 'vec2']], (p) => {
  const q = uvec2(ivec2(p)).mul(uvec2(uint(1597334673), uint(3812015801)))
  return float(q.x.bitXor(q.y).mul(uint(1597334673))).mul(1.0 / 4294967296.0)
})

export const seaNoise = layout('seaNoise', 'float', [['p', 'vec2']], (p) => {
  const i = floor(p)
  const f0 = p.sub(i)
  const f = f0.mul(f0).mul(f0.mul(-2.0).add(3.0))
  return mix(mix(seaHash(i), seaHash(i.add(vec2(1, 0))), f.x), mix(seaHash(i.add(vec2(0, 1))), seaHash(i.add(vec2(1, 1))), f.x), f.y)
})

export const seaOctave = layout('seaOctave', 'float', [['uvIn', 'vec2'], ['choppy', 'float']], (uvIn, choppy) => {
  const uv = uvIn.add(seaNoise(uvIn))
  const wv0 = float(1.0).sub(abs(sin(uv)))
  const wv = mix(wv0, abs(cos(uv)), wv0)
  return pow(float(1.0).sub(pow(wv.x.mul(wv.y), 0.65)), choppy)
})

export const seaHeight = layout('seaHeight', 'float', [['p', 'vec2'], ['t', 'float'], ['oStart', 'int'], ['oEnd', 'int'], ['amp0', 'float'], ['choppy0', 'float']], (p, t, oStart, oEnd, amp0, choppy0) => {
  const freq = float(SEA_FREQ).toVar(), amp = amp0.mul(SEA_AMP_M).toVar(), choppy = choppy0.toVar(), h = float(0).toVar()
  const seaTime = vec2(t.mul(SEA_SPEED * 0.6), t.mul(SEA_SPEED * 0.4))
  Loop({ start: int(0), end: int(SEA_OCTAVES), type: 'int', condition: '<' }, ({ i }) => {
    If(i.greaterThanEqual(oStart).and(i.lessThan(oEnd)), () => {
      const a = float(i).mul(SEA_OCTAVE_ANGLE)
      const sa = sin(a), ca = cos(a)
      const duv = vec2(ca.mul(p.x).add(sa.mul(p.y)), ca.mul(p.y).sub(sa.mul(p.x)))
      const ts = float(1.0).sub(float(i).mul(0.08))
      h.addAssign(seaOctave(duv.add(seaTime.mul(ts)).mul(freq), choppy).mul(amp))
    })
    freq.mulAssign(1.9)
    amp.mulAssign(0.45)
    choppy.assign(mix(choppy, 1.0, 0.3))
  })
  return h
})

export const seaHeightLF = layout('seaHeightLF', 'float', [['p', 'vec2'], ['t', 'float'], ['amp', 'float'], ['choppy', 'float']], (p, t, amp, choppy) => {
  const q = p.mul(SEA_FREQ_LF)
  const a = seaOctave(q.add(vec2(0.866, 0.5).mul(t.mul(SEA_SPEED * 0.6))), choppy)
  const b = seaOctave(q.add(vec2(-0.5, 0.866).mul(t.mul(SEA_SPEED * 0.4))), choppy)
  return a.add(b).mul(amp.mul(SEA_AMP_M * 0.5))
})
