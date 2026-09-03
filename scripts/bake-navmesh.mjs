#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bakeNavmesh } from '../src/pathfinding/RecastIntegration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

// Parse CLI arguments
const args = process.argv.slice(2)
const worldName = args.find(arg => arg.startsWith('--world='))?.replace('--world=', '') || 'aim_sillos'
const verbose = args.includes('--verbose')

const inputPath = path.join(projectRoot, 'apps', 'world', `${worldName}.glb`)
const outputPath = path.join(projectRoot, 'apps', 'world', `${worldName}.navmesh.json`)

async function main() {
  try {
    if (!fs.existsSync(inputPath)) {
      console.error(`Error: World GLB not found: ${inputPath}`)
      process.exit(1)
    }

    console.log(`Baking navmesh for: ${worldName}`)
    console.log(`Input:  ${inputPath}`)
    console.log(`Output: ${outputPath}`)
    console.log()

    const startTime = performance.now()

    const navmeshData = await bakeNavmesh({
      glbPath: inputPath,
      cellSize: 0.3,
      cellHeight: 0.2,
      agentHeight: 1.7,
      agentRadius: 0.4,
      agentMaxClimb: 0.5,
      agentMaxSlope: 45,
      regionMinSize: 8,
      regionMergeSize: 20,
      maxVertsPerPoly: 6,
      tileSize: 32,
      detailSampleDist: 6,
      detailSampleMaxError: 1,
    })

    const bakTime = performance.now() - startTime

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // Write navmesh JSON
    fs.writeFileSync(outputPath, JSON.stringify(navmeshData, null, 2))

    const stats = {
      worldName,
      vertices: navmeshData.vertices.length,
      polygons: navmeshData.polygons.length,
      fileSize: fs.statSync(outputPath).size,
      bakeTimeMs: Math.round(bakTime),
    }

    console.log('Navmesh bake complete!')
    console.log(`  Vertices:  ${stats.vertices}`)
    console.log(`  Polygons:  ${stats.polygons}`)
    console.log(`  File size: ${(stats.fileSize / 1024).toFixed(1)} KB`)
    console.log(`  Bake time: ${stats.bakeTimeMs}ms`)

    if (stats.bakeTimeMs > 30000) {
      console.warn(`\nWarning: Bake took ${(stats.bakeTimeMs / 1000).toFixed(1)}s (target: <30s)`)
    }

    process.exit(0)
  } catch (e) {
    console.error('Navmesh baking failed:')
    console.error(e.message)
    if (verbose) {
      console.error(e.stack)
    }
    process.exit(1)
  }
}

main()
