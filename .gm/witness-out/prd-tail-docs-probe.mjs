import { readFileSync } from 'node:fs'
const R = '/workspace/spoint'
const lines = (p) => readFileSync(R + '/' + p, 'utf8').split('\n')
const out = []
const at = (p, n) => lines(p)[n - 1] ?? ''

// SPECDRIFT-ag-88-1
const agents88 = at('AGENTS.md', 88)
const verifierHits = lines('scripts/lib/verify-doc-claims.mjs').map((l, i) => [i + 1, l]).filter(([, l]) => /nearbyHorizontal/.test(l)).map(([n]) => n)
const octree = readFileSync(R + '/src/spatial/Octree.js', 'utf8')
out.push(`SPECDRIFT-ag-88-1 ${/nearbyHorizontal/.test(agents88) ? 'CONFIRMED' : 'NOT-CONFIRMED'} AGENTS.md:88 mentions nearbyHorizontal=${/nearbyHorizontal/.test(agents88)} verifier-lines=${JSON.stringify(verifierHits)} octreeHasNearbyCylinder=${/nearbyCylinder\(/.test(octree)} octreeHasNearbyHorizontal=${/nearbyHorizontal\(/.test(octree)}`)

// PARSEDV-1-sub1-1: quoted measured numbers at :53 and :109 with no figure slot or provenance tag
const m53 = at('docs/measurement-figures.md', 53), m109 = at('docs/measurement-figures.md', 109)
out.push(`PARSEDV-1-sub1-1 ${/\d/.test(m53) && /\d/.test(m109) && !/\[(ADAPTER|UNSOURCED|SOURCED)/.test(m53 + m109) ? 'CONFIRMED' : 'NOT-CONFIRMED'} :53="${m53.trim().slice(0, 100)}" :109="${m109.trim().slice(0, 100)}"`)

// PARSEDV-1-sub1-2: figure predicate needs an ASCII digit; :129 has [ADAPTER:...] [UNSOURCED] with no digit
const m129 = at('docs/measurement-figures.md', 129)
const verifySrc = readFileSync(R + '/scripts/lib/verify-doc-claims.mjs', 'utf8')
const digitPred = /\[0-9\]|\\d|digit/i.test(verifySrc)
out.push(`PARSEDV-1-sub1-2 ${/ADAPTER:/.test(m129) && /UNSOURCED/.test(m129) && !/\d/.test(m129) && digitPred ? 'CONFIRMED' : 'NOT-CONFIRMED'} :129="${m129.trim().slice(0, 100)}" digitPredicatePresent=${digitPred}`)

// PARSEDV-1-sub1-3: open-question exclusion matches heading text
const excl = verifySrc.match(/.*Open questions.*/)
out.push(`PARSEDV-1-sub1-3 ${excl ? 'CONFIRMED' : 'NOT-CONFIRMED'} exclusion line="${excl ? excl[0].trim().slice(0, 120) : 'none'}"`)

// REPRO-r250-1: is the generator's member order platform-independent? only Linux here
const gen = readFileSync(R + '/scripts/gen-sdk-typings.mjs', 'utf8').split('\n')
const sorted = gen.some(l => /\.sort\(/.test(l))
out.push(`REPRO-r250-1 ${sorted ? 'NOT-CONFIRMED' : 'PARTIAL'} generator sorts members=${sorted}; cross-platform order cannot be witnessed on this Linux box`)
console.log(out.join('\n'))
