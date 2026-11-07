export const CHECK_REL = 'scripts/check.mjs'
export const WITNESS_ROOT = 'scripts'
export const REFUSAL_ABSENT = 'check-pin-witness-absent'
export const REFUSAL_EMPTY_PARSE = 'check-pin-parse-empty'

const QUOTED_FILE_PIN_RE = /file:\s*'([^']+)'/g

export function witnessRel(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\.\//, '')
  return clean.startsWith(WITNESS_ROOT + '/') ? clean : WITNESS_ROOT + '/' + clean
}

export function parseCheckPins(checkText) {
  const pins = []
  const text = String(checkText ?? '')
  QUOTED_FILE_PIN_RE.lastIndex = 0
  let m
  while ((m = QUOTED_FILE_PIN_RE.exec(text)) !== null) {
    const rel = witnessRel(m[1])
    if (!pins.includes(rel)) pins.push(rel)
  }
  return pins
}

export function missingCheckPins({ pins, publishing, remoteHas }) {
  const carried = publishing instanceof Set ? publishing : new Set(publishing ?? [])
  const missing = []
  for (const rel of pins ?? []) {
    if (carried.has(rel)) continue
    if (remoteHas && remoteHas(rel)) continue
    missing.push(rel)
  }
  return missing
}

export function checkPinRefusal({ missing, publishingPaths = [], checkRel = CHECK_REL }) {
  const together = [...new Set([...(publishingPaths ?? []), ...(missing ?? [])])]
  return [
    `${REFUSAL_ABSENT}: REFUSING PUBLISH -- ${checkRel} pins ${(missing ?? []).length} witness file(s) that this commit does not write and that are absent from the remote tree it is parented on:`,
    ...(missing ?? []).map((rel) => '  ' + rel),
    `a path-scoped publish in a shared work tree is not content-scoped, so the ${checkRel} blob being written carries whatever sibling lanes currently have uncommitted in it; publishing it alone puts a pin on remote for a witness remote has never seen, and CI answers "never ran: unreadable (ENOENT)" for that row.`,
    'fix: publish these path(s) in the SAME commit as ' + checkRel + ':',
    '  node scripts/lib/git-api-publish.mjs --message-file=<msg> ' + together.join(' '),
  ]
}

export const emptyParseRefusal = (checkRel = CHECK_REL) => [
  `${REFUSAL_EMPTY_PARSE}: REFUSING PUBLISH -- ${checkRel} is being written but 0 pinned witness file(s) were parsed out of it.`,
  'a check.mjs with no pin rows is not the spoint gate, and a parse that reads 0 pins is a gate that refuses nothing, so this publish is stopped rather than allowed.',
  'fix: publish the real ' + checkRel + ', or teach parseCheckPins() the pin table shape it no longer reads.',
]
