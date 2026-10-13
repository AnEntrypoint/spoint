// A path-scoped publish in a shared work tree is not content-scoped. The blob scripts/lib/
// git-api-publish.mjs writes for scripts/check.mjs is whatever the shared tree holds at that
// moment, so it carries pin rows a sibling lane added for a witness it has not published yet;
// remote main then runs a `must` regex against a file that is not there and the check arm answers
// "never ran: unreadable (ENOENT ...), so its assertions never ran". This gate reads the pin rows
// out of the check.mjs blob being written and refuses when a pinned witness is neither carried by
// the same commit nor already on the remote tree the commit is parented on.

export const CHECK_REL = 'scripts/check.mjs'
export const WITNESS_ROOT = 'scripts'
export const REFUSAL_ABSENT = 'check-pin-witness-absent'
export const REFUSAL_EMPTY_PARSE = 'check-pin-parse-empty'

// check.mjs names a witness relative to scripts/ (join('scripts', spec.file)), in two pin tables
// today -- NO_GPU_WITNESSES and SLOW_NO_GPU_WITNESSES -- and the row asks for every table carrying
// a `file:` entry, so the parse takes every quoted `file:` literal in the blob rather than one
// named table. Over-collecting refuses a publish that would have been fine; under-collecting lets
// the defect through, and only one of those is the direction this class of bug has ever gone.
const PIN_RE = /file:\s*'([^']+)'/g

export function witnessRel(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\.\//, '')
  return clean.startsWith(WITNESS_ROOT + '/') ? clean : WITNESS_ROOT + '/' + clean
}

export function parseCheckPins(checkText) {
  const pins = []
  const text = String(checkText ?? '')
  PIN_RE.lastIndex = 0
  let m
  while ((m = PIN_RE.exec(text)) !== null) {
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
