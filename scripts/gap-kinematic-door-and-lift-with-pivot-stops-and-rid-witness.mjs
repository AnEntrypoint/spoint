import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { default: door, leafAngle } = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'stdlib-apps', 'door', 'index.js')).href)

const failures = []
const expect = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

const opts = { swing: 1, hold: 1, open: Math.PI / 2 }
expect('closed through first hold', leafAngle(0.5, opts) === 0)
expect('mid swing is half open', near(leafAngle(1.5, opts), Math.PI / 4))
expect('open stop holds', leafAngle(2.5, opts) === Math.PI / 2)
expect('closing swing is half open', near(leafAngle(3.5, opts), Math.PI / 4))
expect('cycle wraps to closed', leafAngle(4, opts) === 0)
expect('negative time wraps into cycle', near(leafAngle(-2.5, opts), Math.PI / 4))

const calls = []
const ctx = {
  entity: { id: 7, position: [1, 0, 0], custom: {} },
  config: { sx: 2, swing: 1, hold: 1, openAngle: 90 },
  state: {},
  world: { setPosition: (id, pos, rot) => calls.push({ id, pos, rot }) },
}
door.server.setup(ctx)
expect('setup stamps box mesh with width', ctx.entity.custom.mesh === 'box' && ctx.entity.custom.sx === 2)
expect('setup derives hinge from closed centre', near(ctx.state._hinge[0], 0) && ctx.state._hinge[2] === 0)

const step = (dt) => {
  calls.length = 0
  door.server.update(ctx, dt)
  return calls[0]
}

let c = step(0)
expect('closed leaf sits at hinge plus half width', c && near(c.pos[0], 1) && near(c.pos[2], 0), c && JSON.stringify(c.pos))
expect('closed leaf has identity rotation', c && near(c.rot[1], 0) && near(c.rot[3], 1))

c = step(1.5)
expect('swing at t=1.5 is 45 deg about the hinge', c && near(c.rot[1], Math.sin(Math.PI / 8)) && near(c.rot[3], Math.cos(Math.PI / 8)))
expect('swing keeps the leaf on the hinge radius', c && near(Math.hypot(c.pos[0] - 0, c.pos[2] - 0), 1))

c = step(0.5)
expect('open stop at t=2 rotates 90 deg', c && near(c.rot[1], Math.sin(Math.PI / 4)) && near(c.rot[3], Math.cos(Math.PI / 4)))
expect('open leaf centre is the hinge swung to -z', c && near(c.pos[0], 0) && near(c.pos[2], -1), c && JSON.stringify(c.pos))

c = step(1.5)
expect('return swing at t=3.5 is 45 deg', c && near(c.rot[1], Math.sin(Math.PI / 8)))

c = step(2.5)
expect('next cycle reopens to the open stop at t=6', c && near(c.rot[3], Math.cos(Math.PI / 4)))

if (failures.length) {
  console.log('RESULT: FAIL')
  process.exitCode = 1
} else {
  console.log('RESULT: PASS')
}
