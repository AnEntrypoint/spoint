export function slerpQuat(out, q1, q2, t) {
  if (!q1 || !q2) {
    const src = q2 || q1 || [0, 0, 0, 1]
    out[0] = src[0]; out[1] = src[1]; out[2] = src[2]; out[3] = src[3]
    return
  }
  let x1 = q1[0], y1 = q1[1], z1 = q1[2], w1 = q1[3]
  let x2 = q2[0], y2 = q2[1], z2 = q2[2], w2 = q2[3]
  let dot = x1 * x2 + y1 * y2 + z1 * z2 + w1 * w2
  if (dot < 0) { x2 = -x2; y2 = -y2; z2 = -z2; w2 = -w2; dot = -dot }
  if (dot > 0.9995) {
    const ox = x1+(x2-x1)*t, oy = y1+(y2-y1)*t, oz = z1+(z2-z1)*t, ow = w1+(w2-w1)*t
    const len = Math.sqrt(ox*ox+oy*oy+oz*oz+ow*ow)
    out[0]=ox/len; out[1]=oy/len; out[2]=oz/len; out[3]=ow/len; return
  }
  dot = Math.min(1, dot)
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  if (sinTheta < 0.001) { out[0] = x1+(x2-x1)*t; out[1] = y1+(y2-y1)*t; out[2] = z1+(z2-z1)*t; out[3] = w1+(w2-w1)*t; return }
  const s1 = Math.sin((1 - t) * theta) / sinTheta
  const s2 = Math.sin(t * theta) / sinTheta
  out[0] = x1 * s1 + x2 * s2; out[1] = y1 * s1 + y2 * s2; out[2] = z1 * s1 + z2 * s2; out[3] = w1 * s1 + w2 * s2
}
