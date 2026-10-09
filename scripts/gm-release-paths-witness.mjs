import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_WORKFLOW = 'C:/dev/gm/rs-plugkit/.github/workflows/release.yml';
const WORKFLOW_FLAG = '--workflow=';
const PATTERN_CHARSET = /^[A-Za-z0-9_.\-\/*?]+$/;

const EXPECTATIONS = [
  { path: 'crates/plugkit-core/src/orchestrator/instructions/prose/entry.md', ignored: false },
  { path: 'crates/plugkit-core/src/lib.rs', ignored: false },
  { path: 'README.md', ignored: true },
  { path: 'docs/x.md', ignored: true },
  { path: 'LICENSE', ignored: true },
  { path: '.gitignore', ignored: true },
];

const indentOf = (line) => line.length - line.trimStart().length;
const isBlankOrComment = (line) => line.trim() === '' || line.trimStart().startsWith('#');
const stripTrailingComment = (text) => text.replace(/\s+#.*$/, '').trim();

const parseItems = (text) => {
  const items = [];
  let current = null;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (quote === "'" && ch === "'" && text[i + 1] === "'") {
        current += "'";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current = current ?? '';
    } else if (ch === ',') {
      if (current !== null) items.push(current.trim());
      current = null;
    } else if (current === null) {
      if (!/\s/.test(ch)) current = ch;
    } else {
      current += ch;
    }
  }
  if (current !== null) items.push(current.trim());
  return items.filter((item) => item.length > 0);
};

const findPushBlock = (lines) => {
  const start = lines.findIndex((line) => /^\s*push\s*:\s*$/.test(line));
  if (start < 0) throw new Error('no push trigger block in workflow');
  const indent = indentOf(lines[start]);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!isBlankOrComment(lines[i]) && indentOf(lines[i]) <= indent) {
      end = i;
      break;
    }
  }
  return { start, end };
};

const readFlowOrBlock = (lines, keyIndex, keyIndent, rawValue) => {
  const value = stripTrailingComment(rawValue);
  if (value.startsWith('[')) {
    let joined = value;
    let next = keyIndex;
    while (!joined.includes(']') && next + 1 < lines.length) {
      next += 1;
      joined += ' ' + lines[next].trim();
    }
    if (!joined.includes(']')) throw new Error('unterminated flow sequence at line ' + (keyIndex + 1));
    return parseItems(joined.slice(1, joined.lastIndexOf(']')));
  }
  if (value !== '') return parseItems(value);
  const items = [];
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) <= keyIndent) break;
    const entry = lines[i].trimStart().match(/^-\s+(.*)$/);
    if (entry === null) throw new Error('unexpected line in paths-ignore block at line ' + (i + 1));
    items.push(...parseItems(stripTrailingComment(entry[1])));
  }
  return items;
};

const readPushPathsIgnore = (lines) => {
  const block = findPushBlock(lines);
  const found = [];
  for (let i = block.start + 1; i < block.end; i += 1) {
    const key = lines[i].match(/^(\s*)paths-ignore\s*:(.*)$/);
    if (key === null) continue;
    found.push({ line: i + 1, patterns: readFlowOrBlock(lines, i, key[1].length, key[2]) });
  }
  if (found.length !== 1) throw new Error('expected one paths-ignore under push, found ' + found.length);
  return found[0];
};

const assertPatterns = (patterns) => {
  if (patterns.length === 0) throw new Error('paths-ignore list is empty');
  const bad = patterns.find((pattern) => !PATTERN_CHARSET.test(pattern));
  if (bad !== undefined) throw new Error('unsupported glob syntax in pattern ' + JSON.stringify(bad));
};

const globToRegExp = (pattern) => {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '.') {
      source += '\\.';
    } else {
      source += ch;
    }
  }
  return new RegExp('^' + source + '$');
};

const workflowPathFromArgs = () => {
  const flag = process.argv.find((arg) => arg.startsWith(WORKFLOW_FLAG));
  return flag === undefined ? DEFAULT_WORKFLOW : flag.slice(WORKFLOW_FLAG.length);
};

const run = () => {
  const workflowPath = workflowPathFromArgs();
  const out = [
    'ts: ' + new Date().toISOString(),
    'workflow: ' + workflowPath,
    'parser: hand-rolled flow/block YAML reader (js-yaml not used)',
  ];
  let ok = false;
  try {
    if (!existsSync(workflowPath)) throw new Error('workflow file not found');
    const lines = readFileSync(workflowPath, 'utf8').split(/\r?\n/);
    const { line, patterns } = readPushPathsIgnore(lines);
    assertPatterns(patterns);
    out.push('push paths-ignore (line ' + line + '): ' + JSON.stringify(patterns));
    const results = EXPECTATIONS.map((expectation, index) => {
      const hit = patterns.find((pattern) => globToRegExp(pattern).test(expectation.path));
      const ignored = hit !== undefined;
      const pass = ignored === expectation.ignored;
      out.push(
        'check ' + (index + 1) + ': ' + expectation.path +
        ' ignored=' + ignored + ' expected=' + expectation.ignored +
        ' matched_by=' + (hit === undefined ? 'none' : JSON.stringify(hit)) +
        ' ' + (pass ? 'ok' : 'FAIL'),
      );
      return pass;
    });
    ok = results.every(Boolean);
  } catch (error) {
    out.push('reason: ' + error.message);
  }
  out.push('RESULT: ' + (ok ? 'PASS' : 'FAIL'));
  console.log(out.join('\n'));
  process.exitCode = ok ? 0 : 1;
};

run();
