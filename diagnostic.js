#!/usr/bin/env node

/**
 * Diagnostic script to analyze animation library and VRM structure
 * Usage: node diagnostic.js
 * This script doesn't require the server to be running
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('=== SPAWNPOINT ANIMATION DIAGNOSTIC ===\n');

// Check for required files
const requiredFiles = [
  { name: 'World Config', path: './apps/world/index.js' },
  { name: 'Animation Module', path: './client/animation.js' },
  { name: 'App Module', path: './client/app.js' }
];

console.log('Checking required files:');
for (const file of requiredFiles) {
  const fullPath = path.join(__dirname, file.path);
  const exists = fs.existsSync(fullPath);
  console.log(`  ${file.name}: ${exists ? '✓' : '✗'} ${fullPath}`);
}

// Read world config to find player model
console.log('\n--- World Configuration ---');
const worldConfig = await import('./apps/world/index.js');
const config = worldConfig.default;
console.log(`Player Model: ${config.playerModel}`);
console.log(`Tick Rate: ${config.tickRate} TPS`);
console.log(`Animation Config:`, config.animation);

// Check for asset files in the tps-game directory
console.log('\n--- Asset Files ---');
const tpsGameDir = path.join(__dirname, 'apps', 'tps-game');
if (fs.existsSync(tpsGameDir)) {
  const files = fs.readdirSync(tpsGameDir);
  console.log(`Files in ${tpsGameDir}:`);
  for (const file of files) {
    const fullPath = path.join(tpsGameDir, file);
    const stat = fs.statSync(fullPath);
    const size = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`  ${file} (${size} MB)`);
  }
} else {
  console.log(`  Directory not found: ${tpsGameDir}`);
}

// Check for animation library
console.log('\n--- Animation Library ---');
const clientDir = path.join(__dirname, 'client');
if (fs.existsSync(clientDir)) {
  const files = fs.readdirSync(clientDir);
  console.log(`Client directory files:`, files.filter(f => f.endsWith('.glb') || f.endsWith('.gltf')));
} else {
  console.log('  Client directory not found');
}

// Analyze animation.js for key patterns
console.log('\n--- Animation Module Analysis ---');
const animCode = fs.readFileSync(path.join(__dirname, 'client', 'animation.js'), 'utf-8');
const hasRetargeting = animCode.includes('retargetClip');
const hasElbowLogging = animCode.includes('findElbowBones');
console.log(`Has retargeting: ${hasRetargeting ? '✓' : '✗'}`);
console.log(`Has elbow diagnostics: ${hasElbowLogging ? '✓' : '✗'}`);

// Check for bone patterns in animation code
const LOWER_BODY_MATCH = animCode.match(/LOWER_BODY_BONES = new Set\(\[([\s\S]*?)\]\)/);
if (LOWER_BODY_MATCH) {
  const bones = LOWER_BODY_MATCH[1].split(',').map(b => b.trim().replace(/'/g, ''));
  console.log(`Lower body bones defined: ${bones.length} bones`);
}

console.log('\n--- Summary ---');
console.log('To investigate elbow rotation issues:');
console.log('1. Start the server: npm start');
console.log('2. Open http://localhost:3000 in your browser');
console.log('3. Open browser console (F12)');
console.log('4. Look for [anim] and [vrm] log messages');
console.log('5. Check getRetargetingStatus() on the animator');
console.log('\nKey things to verify:');
console.log('- Are elbows/forearms detected in source animation?');
console.log('- Is retargeting being called successfully?');
console.log('- Do elbows match between source and retargeted clips?');
