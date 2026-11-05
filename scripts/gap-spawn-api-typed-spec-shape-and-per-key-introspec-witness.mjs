import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts/spec-shape.mjs')

const failures = []
function expect(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` :: ${detail}`}`)
  if (!ok) failures.push(label)
}

const dir = mkdtempSync(join(tmpdir(), 'spec-shape-'))
try {
  const fixture = join(dir, 'fixture.d.ts')
  writeFileSync(fixture, [
    "export declare type Color = 'red' | 'green' | Array<number>;",
    'export interface Spec {',
    '    name: string;',
    '    size?: number;',
    '    run(x: number): void;',
    '}',
    '',
  ].join('\n'))

  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

  const union = run(['Color', '--union', '--file', fixture])
  expect('union members print one per line', union.status === 0 && union.stdout === "'red'\n'green'\nArray<number>\n", JSON.stringify(union))

  const member = run(['Spec', '--member', 'size', '--file', fixture])
  expect('member prints its declaration line', member.status === 0 && member.stdout.trim() === 'size?: number;', JSON.stringify(member))

  const method = run(['Spec', '--member', 'run', '--file', fixture])
  expect('method member prints its signature', method.status === 0 && method.stdout.trim() === 'run(x: number): void;', JSON.stringify(method))

  const whole = run(['Spec', '--file', fixture])
  expect('bare name prints the whole declaration', whole.status === 0 && whole.stdout.startsWith('export interface Spec {') && whole.stdout.includes('name: string;'), JSON.stringify(whole))

  const missingMember = run(['Spec', '--member', 'nope', '--file', fixture])
  expect('unknown member exits 4', missingMember.status === 4, `status=${missingMember.status}`)

  const missingName = run(['Nope', '--file', fixture])
  expect('unknown name exits 3', missingName.status === 3, `status=${missingName.status}`)

  const notUnion = run(['Spec', '--union', '--file', fixture])
  expect('--union on an interface exits 5', notUnion.status === 5, `status=${notUnion.status}`)

  const noArgs = run([])
  expect('no name exits 2 with usage', noArgs.status === 2 && noArgs.stderr.includes('usage:'), `status=${noArgs.status}`)

  const generated = run(['AppContext', '--member', '_runtime'])
  expect('generated AppContext member _runtime resolves', generated.status === 0 && generated.stdout.trim() === '_runtime: any;', JSON.stringify(generated))

  const generatedWhole = run(['AppContext'])
  expect('generated AppContext declaration is a class', generatedWhole.status === 0 && generatedWhole.stdout.startsWith('export declare class AppContext {'), JSON.stringify(generatedWhole.stdout.slice(0, 80)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`RESULT: FAIL (${failures.length} failed)`)
  process.exitCode = 1
} else {
  console.log('RESULT: PASS')
}
