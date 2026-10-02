export default function arena({ size = 20, wallHeight = 0, floorColor, wallColor } = {}) {
  const tint = c => (c === undefined ? {} : { color: c })
  const entities = [{ id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: size, hy: 1, hz: size, ...tint(floorColor) } }]
  if (wallHeight > 0) {
    const h = wallHeight / 2
    entities.push(
      { id: 'wall-n', app: 'box-static', position: [0, h, -size - 0.5], config: { hx: size + 1, hy: h, hz: 0.5, ...tint(wallColor) } },
      { id: 'wall-s', app: 'box-static', position: [0, h, size + 0.5], config: { hx: size + 1, hy: h, hz: 0.5, ...tint(wallColor) } },
      { id: 'wall-w', app: 'box-static', position: [-size - 0.5, h, 0], config: { hx: 0.5, hy: h, hz: size, ...tint(wallColor) } },
      { id: 'wall-e', app: 'box-static', position: [size + 0.5, h, 0], config: { hx: 0.5, hy: h, hz: size, ...tint(wallColor) } }
    )
  }
  return { entities }
}
