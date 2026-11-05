import { readFileSync } from 'node:fs'
const gen = readFileSync('/workspace/spoint/client/editor/sdk-typings.generated.d.ts', 'utf8').split('\n')
const ctx = readFileSync('/workspace/spoint/types/ctx.d.ts', 'utf8').split('\n')
const lines = gen.map((l, i) => ({ n: i + 1, l })).filter(x => /setLinearDamping|: any\)/.test(x.l)).map(x => `${x.n}: ${x.l.trim()}`)
const ctxLine = ctx.map((l, i) => ({ n: i + 1, l })).filter(x => /setLinearDamping/.test(x.l)).map(x => `${x.n}: ${x.l.trim()}`)
const anyCount = gen.filter(l => /\(v: any\)/.test(l)).length
console.log(JSON.stringify({ generated: lines, ctx: ctxLine, bareAnyParamCount: anyCount }, null, 1))
