import { readFileSync } from 'node:fs'
import { createAbilityTree, DEFINITION_REFUSAL } from '/workspace/spoint/src/game/AbilityTree.js'
const src = readFileSync('/workspace/spoint/src/game/AbilityTree.js', 'utf8')
const throws = src.split('\n').filter(l => /\bthrow\b/.test(l)).length
const tree = createAbilityTree()
const attempt = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e.constructor.name + ': ' + e.message } } }
const probes = {
  throwStatementsInFile: throws,
  definitionRefusalKinds: Object.keys(DEFINITION_REFUSAL),
  castAbilityUnknownId: attempt(() => tree.castAbility(null, 'no-such-ability', {})),
  canCastAbilityUnknownId: attempt(() => tree.canCastAbility(null, 'no-such-ability')),
  canCastAbilityNullPlayer: attempt(() => tree.canCastAbility(null, 1)),
  entryPointCount: Object.keys(tree).length
}
console.log(JSON.stringify(probes, null, 2))
