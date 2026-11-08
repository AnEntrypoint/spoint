import { existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

function nodeModulesRealRoots(fpResolved, baseResolved) {
  const roots = []
  let at = baseResolved
  for (const segment of fpResolved.slice(baseResolved.length + 1).split(sep).slice(0, -1)) {
    at = join(at, segment)
    if (segment !== 'node_modules') continue
    try { roots.push(realpathSync(at)) } catch { continue }
  }
  return roots
}

export function containedRealFile(fp, dir) {
  const baseResolved = resolve(dir)
  const fpResolved = resolve(fp)
  if (!fpResolved.startsWith(baseResolved + sep)) return false
  if (!existsSync(fp) || !statSync(fp).isFile()) return false
  let realFp
  try { realFp = realpathSync(fp) } catch { return false }
  const allowedRoots = [baseResolved, ...nodeModulesRealRoots(fpResolved, baseResolved)]
  return allowedRoots.some((root) => realFp === root || realFp.startsWith(root + sep))
}
