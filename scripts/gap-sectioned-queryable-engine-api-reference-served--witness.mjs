import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSection, parseSections, slugify } from './lib/doc-sections.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8')
const fixture = '# Top\n\nintro\n\n## Alpha\n\nalpha body\n\n```\n# not a heading\n```\n\n### Alpha child\n\nchild body\n\n## Beta\n\nbeta body\n'

let failures = 0
function expect(name, ok) {
  if (ok) console.log(`PASS ${name}`)
  else { failures += 1; console.log(`FAIL ${name}`) }
}

expect('slugify lowercases and hyphenates a heading', slugify('Working rules & PRD') === 'working-rules-prd')
expect('parseSections skips headings inside fences', parseSections(fixture).every((s) => s.title !== 'not a heading'))
expect('parseSections keeps every real heading in order', parseSections(fixture).map((s) => s.title).join('|') === 'Top|Alpha|Alpha child|Beta')
expect('getSection stops at the next heading of the same or higher level', getSection(fixture, 'alpha').endsWith('child body') && !getSection(fixture, 'alpha').includes('beta body'))
expect('getSection includes a deeper child section', getSection(fixture, 'alpha').includes('### Alpha child'))
expect('getSection returns null for an unknown slug', getSection(fixture, 'missing') === null)
expect('AGENTS.md exposes more than 10 sections', parseSections(agents).length > 10)
const rules = getSection(agents, 'working-rules')
expect('AGENTS.md Working rules section is found and carries git_commit', rules !== null && rules.startsWith('## Working rules') && rules.includes('git_commit'))
expect('AGENTS.md Working rules section stops before the PRD section', rules !== null && !rules.includes('## PRD rows and witness binding'))

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
