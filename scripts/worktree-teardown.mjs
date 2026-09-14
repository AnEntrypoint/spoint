import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const worktreeArg = process.argv[2]
if (!worktreeArg) {
  console.error('usage: node scripts/worktree-teardown.mjs <worktree-path>')
  process.exit(2)
}
const worktree = resolve(worktreeArg)
if (!existsSync(worktree)) {
  console.error(`[worktree-teardown] ${worktree} does not exist`)
  process.exit(2)
}

const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' }).trim()
const mainRoot = dirname(resolve(worktree, commonDir))
if (resolve(mainRoot).toLowerCase() === worktree.toLowerCase()) {
  console.error(`[worktree-teardown] refusing: ${worktree} is the main checkout, not a linked worktree`)
  process.exit(2)
}

const mainInstallMarker = join(mainRoot, 'node_modules', '.package-lock.json')
const mainWasInstalled = existsSync(mainInstallMarker)

function unlinkEveryLinkBelow(dir, removed) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git') continue
    const full = join(dir, entry)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) { rmSync(full); removed.push(full); continue }
    if (st.isDirectory()) unlinkEveryLinkBelow(full, removed)
  }
  return removed
}

const unlinked = unlinkEveryLinkBelow(worktree, [])
for (const link of unlinked) console.log(`[worktree-teardown] unlinked ${link}`)

execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: mainRoot, stdio: 'inherit' })

if (mainWasInstalled && !existsSync(mainInstallMarker)) {
  console.error(`[worktree-teardown] ${mainInstallMarker} disappeared during teardown -- main node_modules was damaged; run npm install in ${mainRoot}`)
  process.exit(1)
}
console.log(`[worktree-teardown] removed ${worktree}; main node_modules intact`)
