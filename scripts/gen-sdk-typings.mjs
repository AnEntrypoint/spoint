#!/usr/bin/env node
// Generate ambient .d.ts typings for the ctx.* app SDK surface (src/apps/AppContext.js)
// via the real `tsc` CLI (--allowJs --declaration --emitDeclarationOnly), instead of
// hand-maintaining client/editor/sdk-typings.d.ts by eye every time AppContext.js's
// public surface changes.
//
// Note on approach: the installed `typescript` devDependency is the 7.x native/Go
// rewrite, whose npm package exposes ONLY `version`/`versionMajorMinor` -- none of the
// classic JS Compiler API (`ts.createProgram` etc, see
// https://github.com/microsoft/typescript-go) is available to `require('typescript')`
// at this version. So this script shells out to the real `tsc` binary (still fully
// functional for --allowJs --declaration --emitDeclarationOnly) rather than the
// programmatic API. If a future upgrade restores the JS API, swap the execFile call
// for a createProgram()+getEmitOutput() pass -- the rest of this script (temp dir,
// diff summary) stays the same.
//
// This does NOT overwrite the curated, hand-maintained client/editor/sdk-typings.d.ts
// in place: tsc's structural inference over plain JS (no formal @param/@returns JSDoc
// blocks in AppContext.js today) produces `any`-typed parameters almost everywhere,
// which is a real regression for Monaco autocomplete quality vs the hand-written file's
// concrete tuple/union types. Instead this writes a SEPARATE generated file
// (client/editor/sdk-typings.generated.d.ts) plus a drift report, so the generated
// output can be diffed against the hand-maintained surface (new/removed method names,
// changed signatures) without silently discarding better hand-written types. Promoting
// generated output to replace the hand-maintained file is a deliberate, reviewed edit,
// not an automatic side effect of running this script.
//
// Usage: node scripts/gen-sdk-typings.mjs   (npm run gen-typings)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SOURCE = join(ROOT, 'src/apps/AppContext.js')
const HAND_MAINTAINED = join(ROOT, 'client/editor/sdk-typings.d.ts')
const GENERATED_OUT = join(ROOT, 'client/editor/sdk-typings.generated.d.ts')
// Invoke tsc's JS entrypoint directly via `node`, not the node_modules/.bin shim --
// the .cmd shim on Windows fails with `spawn EINVAL` under execFile without a shell,
// and going through `node <script>` is portable across platforms either way.
const TSC_BIN = join(ROOT, 'node_modules/typescript/bin/tsc')

function extractMemberNames(dtsText) {
  // Cheap structural scan (not a real TS parse -- this file has no `typescript`
  // classic API available to walk an AST with, see note above): pull identifier-like
  // names that look like method/property declarations at any indent level, for a
  // same-vs-added/removed drift summary between the two files.
  const names = new Set()
  const re = /^\s*(?:get |set )?(readonly )?([A-Za-z_$][\w$]*)\s*[(:?]/gm
  let m
  while ((m = re.exec(dtsText))) {
    const name = m[2]
    if (['interface', 'declare', 'class', 'export', 'import', 'const', 'type'].includes(name)) continue
    names.add(name)
  }
  return names
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`[gen-sdk-typings] source not found: ${SOURCE}`)
    process.exit(1)
  }
  if (!existsSync(TSC_BIN)) {
    console.error(`[gen-sdk-typings] tsc not found at ${TSC_BIN} -- is 'typescript' installed as a devDependency? (npm install --save-dev typescript)`)
    process.exit(1)
  }

  const tmp = mkdtempSync(join(tmpdir(), 'sdk-typings-'))
  try {
    const args = [
      '--allowJs', '--declaration', '--emitDeclarationOnly',
      '--outDir', tmp,
      '--skipLibCheck',
      '--moduleResolution', 'bundler',
      '--module', 'esnext',
      '--target', 'es2022',
      '--checkJs', 'false',
      SOURCE
    ]
    console.log(`[gen-sdk-typings] running: node ${TSC_BIN} ${args.join(' ')}`)
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [TSC_BIN, ...args], { cwd: ROOT })
      if (stdout.trim()) console.log(stdout.trim())
      if (stderr.trim()) console.error(stderr.trim())
    } catch (e) {
      // tsc exits non-zero on any diagnostic even with emitDeclarationOnly; still
      // check whether the .d.ts landed (allowJs type errors are commonly non-fatal
      // to declaration emit) before treating this as a hard failure.
      console.warn('[gen-sdk-typings] tsc reported diagnostics:')
      console.warn((e.stdout || e.message || String(e)).trim())
    }

    const emitted = join(tmp, 'src/apps/AppContext.d.ts')
    if (!existsSync(emitted)) {
      console.error(`[gen-sdk-typings] tsc did not emit ${emitted} -- aborting, see diagnostics above.`)
      process.exit(1)
    }

    const generated = readFileSync(emitted, 'utf8')
    const header = `// AUTO-GENERATED by scripts/gen-sdk-typings.mjs (npm run gen-typings) from src/apps/AppContext.js.\n` +
      `// Structural inference only (AppContext.js has no formal @param/@returns JSDoc blocks yet, so\n` +
      `// parameter/return types are mostly 'any') -- NOT a drop-in replacement for the hand-curated\n` +
      `// client/editor/sdk-typings.d.ts Monaco typings. Regenerate: npm run gen-typings.\n// DO NOT EDIT BY HAND.\n\n`
    writeFileSync(GENERATED_OUT, header + generated, 'utf8')
    console.log(`[gen-sdk-typings] wrote ${GENERATED_OUT} (${generated.split('\n').length} lines)`)

    if (existsSync(HAND_MAINTAINED)) {
      const handText = readFileSync(HAND_MAINTAINED, 'utf8')
      const handNames = extractMemberNames(handText)
      const genNames = extractMemberNames(generated)

      const missingFromHand = [...genNames].filter(n => !handNames.has(n)).sort()
      const missingFromGenerated = [...handNames].filter(n => !genNames.has(n)).sort()

      console.log('\n[gen-sdk-typings] drift report vs client/editor/sdk-typings.d.ts:')
      console.log(`  members in generated but not in hand-maintained (${missingFromHand.length}): ${missingFromHand.join(', ') || '(none)'}`)
      console.log(`  members in hand-maintained but not in generated  (${missingFromGenerated.length}): ${missingFromGenerated.join(', ') || '(none)'}`)
    } else {
      console.log(`[gen-sdk-typings] no hand-maintained file at ${HAND_MAINTAINED} to diff against.`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(e => { console.error(e); process.exit(1) })
