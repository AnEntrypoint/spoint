import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pagesArg = process.argv.find(a => a.startsWith('--pages='))
const PAGES = pagesArg ? pagesArg.slice('--pages='.length).split(',') : ['client/index.html', 'client/editor/thebird-host.html']
const DESIGN_CSS = 'https://unpkg.com/anentrypoint-design@1.0.34/dist/247420.css'

const failures = []
const report = (name, ok, detail) => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
  if (!ok) failures.push(name)
}

for (const page of PAGES) {
  const text = readFileSync(resolve(ROOT, page), 'utf8')
  const tags = text.split('\n').filter(line => line.includes(DESIGN_CSS) && /<link\s/.test(line))
  const bare = tags.filter(tag => !/\scrossorigin(=|\s|>)/.test(tag))
  report(`${page}-design-stylesheet-cors`, tags.length > 0 && bare.length === 0, `${tags.length} design stylesheet link(s), ${bare.length} without crossorigin (COEP require-corp refuses a no-cors cross-origin stylesheet)`)
}

if (failures.length === 0) console.log(`RESULT: PASS ${PAGES.length} page(s): every design stylesheet link is a CORS request`)
else console.log(`RESULT: FAIL: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
