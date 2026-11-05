import { createRequire as __gmCreateRequire } from 'node:module';
const require = __gmCreateRequire(process.cwd() + '/');

const fs = require('fs');
const root = '/workspace/spoint';
const agents = fs.readFileSync(root + '/AGENTS.md', 'utf8').split('\n');
const verifier = fs.readFileSync(root + '/scripts/lib/verify-doc-claims.mjs', 'utf8').split('\n');
const octree = fs.readFileSync(root + '/src/spatial/Octree.js', 'utf8');
const agentsHits = agents.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('nearbyHorizontal'));
const verifierHits = verifier.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('nearbyHorizontal'));
const positiveControl = octree.includes('nearbyCylinder(position, radius, halfHeight, out)');
const verifierActive = verifierHits.filter(([, l]) => !/^\s*\/\//.test(l) && !/symbol gone/.test(l));
const pass = agentsHits.length === 0 && positiveControl && verifierActive.length === 0;
console.log('AGENTS_nearbyHorizontal_hits=' + agentsHits.length);
console.log('VERIFIER_nearbyHorizontal_lines=' + JSON.stringify(verifierHits.map(([n]) => n)));
console.log('VERIFIER_active_pins=' + verifierActive.length);
console.log('POSITIVE_CONTROL_nearbyCylinder_in_Octree=' + positiveControl);
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exitCode = pass ? 0 : 1;
