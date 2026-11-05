import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUD_DIR = path.join(REPO_ROOT, 'client', 'hud');
const ALLOWED_PROPS = new Set(['opacity', 'transform']);
const KEYFRAMES_RE = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const DECL_RE = /([a-z-]+)\s*:/g;

const results = [];
function expect(name, ok, detail = '') {
  results.push({ name, ok: ok === true });
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

const hudFiles = fs.readdirSync(HUD_DIR).filter((f) => f.endsWith('.js'));
const blocks = [];
for (const file of hudFiles) {
  const src = fs.readFileSync(path.join(HUD_DIR, file), 'utf8');
  for (const m of src.matchAll(KEYFRAMES_RE)) blocks.push({ file, name: m[1], body: m[2] });
}

expect('hud directory has keyframe blocks to check', blocks.length > 0, `count=${blocks.length}`);

for (const b of blocks) {
  const props = [...b.body.matchAll(DECL_RE)].map((m) => m[1]);
  const bad = props.filter((p) => !ALLOWED_PROPS.has(p));
  expect(`keyframes ${b.name} (${b.file}) animates only opacity/transform`, bad.length === 0, bad.length ? `props=${bad.join(',')}` : `props=${[...new Set(props)].join(',')}`);
}

const mobile = fs.readFileSync(path.join(HUD_DIR, 'MobileControlsUI.js'), 'utf8');
expect('joystick glow lives on a shadowed ::after at inset:0', /\.mobile-joystick-base::after\{[^}]*inset:0/.test(mobile));
expect('joystick glow animates ::after opacity, not the base box-shadow', /\.mobile-joystick-base\.active::after\{[^}]*animation:joyGlow/.test(mobile) && !/\.mobile-joystick-base\.active\{[^}]*animation:/.test(mobile));

const failed = results.filter((r) => !r.ok).length;
console.log(`checks=${results.length} failed=${failed}`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
