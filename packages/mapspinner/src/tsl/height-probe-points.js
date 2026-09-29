const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }

function lcg(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

export function heightProbeDirs({ random = 2048, seed = 1337, anchorDir = null } = {}) {
  const dirs = []
  const labels = []
  const push = (d, label) => { dirs.push(norm(d)); labels.push(label) }
  for (const s of [1, -1]) { push([0, s, 0], 'pole'); push([s, 0, 0], 'face-centre'); push([0, 0, s], 'face-centre') }
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) push([sx, sy, sz], 'cube-corner')
  const rnd = lcg(seed)
  for (let i = 0; i < 64; i++) {
    const t = rnd() * 2 - 1, e = (rnd() - 0.5) * 1e-4
    const axis = i % 3, sa = rnd() < 0.5 ? 1 : -1, sb = rnd() < 0.5 ? 1 : -1
    const v = [0, 0, 0]
    v[axis] = t; v[(axis + 1) % 3] = sa * (1 + e); v[(axis + 2) % 3] = sb
    push(v, 'face-seam')
  }
  for (let i = 0; i < 32; i++) {
    const a = rnd() * Math.PI * 2, r = rnd() * 0.02
    for (const s of [1, -1]) push([Math.cos(a) * r, s, Math.sin(a) * r], 'near-pole')
  }
  if (anchorDir) {
    const a = norm(anchorDir)
    for (let i = 0; i < 32; i++) {
      const off = rnd() * 0.01
      push([a[0] + (rnd() - 0.5) * off, a[1] + (rnd() - 0.5) * off, a[2] + (rnd() - 0.5) * off], 'near-anchor')
    }
    push([-a[0], -a[1], -a[2]], 'antipode')
  }
  for (let i = 0; i < random; i++) push([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], 'random')
  return { dirs, labels }
}
