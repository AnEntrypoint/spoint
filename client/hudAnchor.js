const DEFAULT_OFFSET = [0, 2, 0]

export function parseAnchorOffset(text) {
  if (text == null || text === '') return DEFAULT_OFFSET.slice()
  const parts = String(text).trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null
  return parts
}

export function placeAnchoredPlates(container, entities, camera, renderer, THREE, project) {
  let placed = 0
  for (const el of container.querySelectorAll('[data-world-anchor]')) {
    const id = el.getAttribute('data-world-anchor')
    const entity = entities.find((e) => String(e.id) === id)
    const offset = parseAnchorOffset(el.getAttribute('data-anchor-offset'))
    const feet = entity?.position
    if (!feet || !offset) { el.style.display = 'none'; continue }
    const world = { x: feet[0] + offset[0], y: feet[1] + offset[1], z: feet[2] + offset[2] }
    const screen = project(world, camera, renderer, THREE)
    if (!screen || !screen.onScreen) { el.style.display = 'none'; continue }
    const cam = camera.position
    const distance = Math.hypot(world.x - cam.x, world.y - cam.y, world.z - cam.z)
    el.style.display = ''
    el.style.position = 'fixed'
    el.style.left = `${screen.x}px`
    el.style.top = `${screen.y}px`
    el.style.transform = 'translate(-50%, -100%)'
    el.style.setProperty('--anchor-depth', `${distance}`)
    placed += 1
  }
  return placed
}
