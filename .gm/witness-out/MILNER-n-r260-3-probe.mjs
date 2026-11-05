import { createProgressionSystem } from '/workspace/spoint/src/game/ProgressionSystem.js'
import { createAbilityTree } from '/workspace/spoint/src/game/AbilityTree.js'
const out = {}
const prog = createProgressionSystem()
prog.addXp(1, 10)
prog.addXp('1', 10)
out.progressionSameEntryForNumAndString = prog.getPlayerState(1) === prog.getPlayerState('1')
const tree = createAbilityTree()
const api = tree.getPlayerAbilityState ? tree : null
out.abilityApiExposed = api !== null
if (api) out.abilitySameEntryForNumAndString = api.getPlayerAbilityState(1) === api.getPlayerAbilityState('1')
console.log(JSON.stringify(out))
