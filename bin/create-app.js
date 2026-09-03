#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { getTemplateContent } from './templates.js'
import { fileURLToPath } from 'node:url'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))

const TEMPLATES = {
  simple: 'simple',
  physics: 'physics',
  interactive: 'interactive',
  spawner: 'spawner',
  'fsm-game': 'fsm-game'
}

function showHelp() {
  console.log(`
Usage: spoint create-app [options] <app-name>

Options:
  --template <type>   Template to use: simple, physics, interactive, spawner, fsm-game (default: simple)
  --help              Show this help message

Examples:
  spoint create-app my-app
  spoint create-app --template physics my-physics-object
  spoint create-app --template spawner my-spawner
  spoint create-app --template fsm-game my-match
  spoint-create-app my-app
`)
}

function parseArgs(argv) {
  const args = { name: null, template: 'simple' }
  
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') {
      showHelp()
      process.exit(0)
    }
    if (argv[i] === '--template' && argv[i + 1]) {
      args.template = argv[++i]
    } else if (!argv[i].startsWith('--')) {
      args.name = argv[i]
    }
  }
  
  return args
}


function createApp(name, template) {
  const appsDir = resolve('apps')
  const appDir = join(appsDir, name)

  if (existsSync(appDir)) {
    console.error(`Error: App '${name}' already exists at ${appDir}`)
    process.exit(1)
  }

  mkdirSync(appDir, { recursive: true })

  const indexJsPath = join(appDir, 'index.js')
  const indexJsContent = getTemplateContent(template)
  writeFileSync(indexJsPath, indexJsContent)

  console.log(`[ok] Created app: ${name}`)
  console.log(`  Location: ${appDir}`)
  console.log(`  Template: ${template}`)
  console.log(`\nTo test your app:`)
  console.log(`  1. Start server: npm start`)
  console.log(`  2. Connect to http://localhost:3001`)
  console.log(`  3. Add app to apps/world/index.js entities with app: '${name}'`)
  console.log(`  4. Edit ${indexJsPath} to make changes`)
  console.log(`  5. Server hot-reloads automatically`)
}

// Strip a leading 'create-app' token so both entry shapes work identically:
//   npx spoint-create-app my-app           (bin directly, no token to strip)
//   npx spoint create-app my-app --template physics   (server.js forwards here with the token still in argv)
const argvRaw = process.argv.slice(2)
if (argvRaw[0] === 'create-app') argvRaw.shift()

const args = parseArgs(argvRaw)

if (!args.name) {
  console.error('Error: App name required')
  showHelp()
  process.exit(1)
}

if (args.template && !TEMPLATES[args.template]) {
  console.error(`Error: Unknown template '${args.template}'`)
  console.log(`Available: ${Object.keys(TEMPLATES).join(', ')}`)
  process.exit(1)
}

createApp(args.name, args.template)
