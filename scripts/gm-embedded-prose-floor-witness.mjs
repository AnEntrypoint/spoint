import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { flagValue, positionalArg, requireExternalTarget } from './lib/external-target.mjs';

const UNDER_CHECKOUT = 'rs-plugkit/crates/plugkit-core/src/orchestrator/instructions/prose/entry.md';
const argv = process.argv.slice(2);
const { path: target, source } = requireExternalTarget({
  witness: 'gm-embedded-prose-floor-witness',
  label: 'plugkit embedded orchestrator prose entry',
  flagName: 'entry',
  envName: 'GM_PROSE_ENTRY',
  underCheckout: UNDER_CHECKOUT,
  flag: flagValue(argv, 'entry') ?? positionalArg(argv),
  argv,
});

console.log('witness: gm-embedded-prose-floor-witness');
console.log(`path: ${target}`);
console.log(`source: ${source}`);
console.log(`ts: ${new Date().toISOString()}`);

let text;
try {
  text = readFileSync(target, 'utf8');
} catch (err) {
  console.log(`CHECK readable: FAIL ${err.code ?? err.message}`);
  console.log('RESULT: FAIL');
  process.exit(1);
}

const lines = text.split(/\r?\n/);
const numbered = (pattern) => lines.map((line, i) => [i + 1, line]).filter(([, line]) => pattern.test(line)).map(([n]) => n);
console.log(`sha256: ${createHash('sha256').update(text).digest('hex')}`);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`CHECK ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

const floorLines = numbered(/\bfloor 10\b/i);
check('floor-10-stated', floorLines.length > 0, `lines=${floorLines.join(',') || 'none'}`);

const under5 = numbered(/under 5/i);
check('no-under-5', under5.length === 0, `lines=${under5.join(',') || 'none'}`);

const launch16 = numbered(/launch until 16/i);
check('no-launch-until-16', launch16.length === 0, `lines=${launch16.join(',') || 'none'}`);

const refill16 = numbered(/\b(until|to|reaches)\b[^\n]{0,30}\b16\b/i);
check('no-16-refill-target', refill16.length === 0, `lines=${refill16.join(',') || 'none'}`);

const runningOnly = lines.map((line, i) => [i + 1, line]).filter(([, line]) => /subagents_running/.test(line) && !/ListAgents/.test(line)).map(([n]) => n);
check('no-subagents_running-only-count', runningOnly.length === 0, `lines=${runningOnly.join(',') || 'none'}`);

const listAgents = numbered(/ListAgents/);
check('listagents-count-of-record', listAgents.length > 0, `lines=${listAgents.join(',') || 'none'}`);

console.log(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failures === 0 ? 0 : 1);
