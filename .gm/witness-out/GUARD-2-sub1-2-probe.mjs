import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const root = '/workspace/spoint'
const witness = root + '/scripts/fsm-arena-index-witness.mjs'
const tracked = execFileSync('git', ['-C', root, 'log', '--all', '--oneline', '--', 'scripts/fsm-arena-index-witness.mjs'], { encoding: 'utf8' }).trim()
const appSetup = (await import('/workspace/spoint/apps/fsm-arena/index.js')).default.server.setup.toString()
console.log(JSON.stringify({
  witnessFileExists: existsSync(witness),
  witnessEverInGitHistory: tracked.length > 0 ? tracked : null,
  appSetupCallsDefineGameMode: appSetup.includes('buildMatchFSM'),
  buildMatchFSMUsesCtxDefineGameMode: (await import('node:fs')).readFileSync(root + '/apps/fsm-arena/index.js', 'utf8').includes('ctx.defineGameMode(')
}, null, 2))
