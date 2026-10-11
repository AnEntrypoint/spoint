#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HOOKS_DIR = join(ROOT, '.git', 'hooks')
const HOOK_PATH = join(HOOKS_DIR, 'pre-commit')
const CHECK_ONLY = process.argv.includes('--check')

const HOOK_BODY = `#!/bin/sh
# emitted by scripts/install-git-hooks.mjs -- do not edit by hand.
# refuses a commit that changes the src/apps/AppContext.js import closure
# without the regenerated client/editor/sdk-typings.generated.d.ts.
if ! command -v node >/dev/null 2>&1; then
  echo "[git-hook] node is not on PATH; skipping the sdk-typings drift check" >&2
  exit 0
fi
exec node scripts/gen-sdk-typings.mjs --pre-commit
`

function installed() {
  return existsSync(HOOK_PATH) && readFileSync(HOOK_PATH, 'utf8').replace(/\r\n/g, '\n') === HOOK_BODY
}

if (!existsSync(join(ROOT, '.git'))) {
  console.log('[install-git-hooks] no .git here; skipping')
} else if (installed()) {
  console.log('[install-git-hooks] .git/hooks/pre-commit is current')
} else if (existsSync(HOOK_PATH)) {
  console.error('[install-git-hooks] refusing to overwrite a .git/hooks/pre-commit this script did not emit: ' + HOOK_PATH)
} else {
  mkdirSync(HOOKS_DIR, { recursive: true })
  writeFileSync(HOOK_PATH, HOOK_BODY, 'utf8')
  chmodSync(HOOK_PATH, 0o755)
  console.log('[install-git-hooks] installed .git/hooks/pre-commit')
}

if (CHECK_ONLY && !installed()) {
  console.error('[install-git-hooks] .git/hooks/pre-commit is not installed')
  process.exit(1)
}
