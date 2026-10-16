import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { basename, resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const REPOS = [
  {
    name: 'spoint',
    path: ROOT,
    docsDir: 'docs',
    agentsFile: 'AGENTS.md',
    readme: 'README.md',
  },
  {
    name: 'wireweave',
    path: join(ROOT, 'node_modules/wireweave'),
    docsDir: null,
    agentsFile: 'AGENTS.md',
    readme: 'README.md',
  },
  {
    name: 'mapspinner',
    path: join(ROOT, 'packages/mapspinner'),
    docsDir: null,
    agentsFile: 'AGENTS.md',
    readme: 'README.md',
  },
  {
    name: 'streaming-gltf',
    path: join(ROOT, 'packages/streaming-gltf'),
    docsDir: null,
    agentsFile: 'AGENTS.md',
    readme: 'README.md',
  },
]

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

async function readIfExists(p) {
  try { return await readFile(p, 'utf8') } catch { return null }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const BLOCK_START = /^(```|#{1,4} |- )/

function inline(text) {
  return text.split(/(`[^`]+`)/).map((part, i) => i % 2
    ? `<code>${part.slice(1, -1)}</code>`
    : part.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
  ).join('')
}

function markdownToHtml(md) {
  if (!md) return ''
  const lines = escapeHtml(md).split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const code = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i])
      i++
      blocks.push(`<pre><code class="language-${lang}">${code.join('\n')}</code></pre>`)
    } else if (/^#{1,4} /.test(line)) {
      const level = line.match(/^#+/)[0].length
      blocks.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`)
      i++
    } else if (line.startsWith('- ')) {
      const items = []
      for (; i < lines.length && lines[i].startsWith('- '); i++) items.push(`<li>${inline(lines[i].slice(2))}</li>`)
      blocks.push(`<ul>${items.join('')}</ul>`)
    } else if (line.trim() === '') {
      i++
    } else {
      const para = []
      for (; i < lines.length && lines[i].trim() !== '' && !BLOCK_START.test(lines[i]); i++) para.push(lines[i])
      blocks.push(`<p>${inline(para.join(' '))}</p>`)
    }
  }
  return blocks.join('\n')
}

async function collectRepoDocs(repo) {
  const sections = []

  if (repo.agentsFile) {
    const content = await readIfExists(join(repo.path, repo.agentsFile))
    if (content) {
      sections.push({ title: `${repo.name} — AGENTS.md`, content })
    }
  }

  if (repo.readme) {
    const content = await readIfExists(join(repo.path, repo.readme))
    if (content) {
      sections.push({ title: `${repo.name} — README`, content })
    }
  }

  if (repo.docsDir) {
    const docsPath = join(repo.path, repo.docsDir)
    if (await exists(docsPath)) {
      const files = await readdir(docsPath)
      for (const f of files.sort()) {
        if (f.endsWith('.md')) {
          const content = await readFile(join(docsPath, f), 'utf8')
          sections.push({ title: `${repo.name} — docs/${f}`, content })
        }
      }
    }
  }

  return sections
}

async function main() {
  const args = process.argv.slice(2)
  let outPath = join(ROOT, 'docs/index.html')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outPath = args[++i]
  }

  const allSections = []
  for (const repo of REPOS) {
    if (await exists(repo.path)) {
      const sections = await collectRepoDocs(repo)
      allSections.push(...sections)
    }
  }

  const toc = allSections.map((s, i) =>
    `<li><a href="#section-${i}">${escapeHtml(s.title)}</a></li>`
  ).join('\n')

  const body = allSections.map((s, i) =>
    `<section id="section-${i}"><h2>${escapeHtml(s.title)}</h2>${markdownToHtml(s.content)}</section>`
  ).join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spoint — Unified Docs</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --code-bg: #f0f0f0; --border: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1a1a1a; --fg: #e0e0e0; --code-bg: #2a2a2a; --border: #333; } }
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 1rem; background: var(--bg); color: var(--fg); line-height: 1.6; }
  h1 { border-bottom: 2px solid var(--border); padding-bottom: .5rem; }
  h2 { border-bottom: 1px solid var(--border); padding-bottom: .25rem; margin-top: 2rem; }
  code { background: var(--code-bg); padding: .1em .3em; border-radius: 3px; font-size: .9em; }
  pre { background: var(--code-bg); padding: 1rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  nav { margin-bottom: 2rem; }
  nav ul { padding-left: 1.2rem; }
  section { margin-bottom: 3rem; }
  a { color: #0969da; }
  @media (prefers-color-scheme: dark) { a { color: #58a6ff; } }
</style>
</head>
<body>
<h1>spoint — Unified Docs</h1>
<p>Generated from spoint, wireweave, mapspinner, and streaming-gltf AGENTS.md / README / docs.</p>
<nav>
  <h2>Table of Contents</h2>
  <ul>${toc}</ul>
</nav>
${body}
</body>
</html>`

  await writeFile(outPath, html, 'utf8')
  console.log(`Wrote ${allSections.length} sections to ${outPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })