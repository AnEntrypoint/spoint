import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const DATA_DIR = resolve(process.cwd(), 'data')
const FILE = resolve(DATA_DIR, 'placed-models.json')

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

export function load() {
  ensureDir()
  if (!existsSync(FILE)) return []
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8'))
  } catch {
    return []
  }
}

export function save(entities) {
  ensureDir()
  writeFileSync(FILE, JSON.stringify(entities, null, 2))
}
