#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync as readFileSyncRaw } from 'node:fs'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(__dirname, 'project-template')
const TEMPLATES_DIR = join(__dirname, 'project-templates')

const GAME_MODE_TEMPLATES = ['arena-fps', 'battle-royale', 'deathrun']
const TEMPLATES = ['sandbox', ...GAME_MODE_TEMPLATES]

function templateAppsDir(template) {
  return template === 'sandbox' ? join(TEMPLATE_DIR, 'apps') : join(TEMPLATES_DIR, template, 'apps')
}

function showHelp() {
  console.log(`
Usage: spoint create-project [options] <project-name>
       npx create-spoint-game [options] <project-name>

Options:
  --template <type>   Game-mode starting point: ${TEMPLATES.join(', ')} (default: sandbox)
  --help              Show this help message

Scaffolds a new directory <project-name>/ containing only apps/, a world-def, and a package.json
that depends on spoint (the engine) as a normal npm dependency -- no engine files are copied. Run
'npm install' inside the new directory, then 'npm start'.

Examples:
  spoint create-project my-game
  spoint create-project --template arena-fps my-shooter
  spoint create-project --template battle-royale my-br
  spoint create-project --template deathrun my-parkour
`)
}

function readSpointVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSyncRaw(pkgPath, 'utf8'))
    return pkg.version || '0.1.0'
  } catch { return '0.1.0' }
}

export function createProject(name, template = 'sandbox') {
  if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
    console.error('Error: invalid project name (use letters, digits, - and _ only)')
    process.exit(1)
  }
  if (!TEMPLATES.includes(template)) {
    console.error(`Error: Unknown template '${template}'`)
    console.log(`Available: ${TEMPLATES.join(', ')}`)
    process.exit(1)
  }
  const dest = resolve(process.cwd(), name)
  if (existsSync(dest)) {
    console.error(`Error: '${dest}' already exists`)
    process.exit(1)
  }
  mkdirSync(dest, { recursive: true })
  cpSync(templateAppsDir(template), join(dest, 'apps'), { recursive: true })

  const version = readSpointVersion()
  const pkgTemplate = readFileSyncRaw(join(TEMPLATE_DIR, 'package.json.template'), 'utf8')
  writeFileSync(join(dest, 'package.json'), pkgTemplate.replace('__PROJECT_NAME__', name).replace('__SPOINT_VERSION__', version))

  const readmeTemplate = readFileSyncRaw(join(TEMPLATE_DIR, 'README.md.template'), 'utf8')
  writeFileSync(join(dest, 'README.md'), readmeTemplate.replaceAll('__PROJECT_NAME__', name))

  writeFileSync(join(dest, '.gitignore'), readFileSyncRaw(join(TEMPLATE_DIR, 'gitignore.template'), 'utf8'))

  console.log(`[ok] Created ${name}/`)
  console.log(`  Template: ${template}`)
  console.log(`\nNext steps:`)
  console.log(`  cd ${name}`)
  console.log(`  npm install`)
  console.log(`  npm start`)
}

function parseArgs(argv) {
  const args = { name: null, template: 'sandbox' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--template' && argv[i + 1]) {
      args.template = argv[++i]
    } else if (!argv[i].startsWith('--')) {
      args.name = argv[i]
    }
  }
  return args
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.length === 0) {
  showHelp()
  process.exit(argv.length === 0 ? 1 : 0)
}
const args = parseArgs(argv)
if (!args.name) {
  console.error('Error: project name required')
  showHelp()
  process.exit(1)
}
createProject(args.name, args.template)
