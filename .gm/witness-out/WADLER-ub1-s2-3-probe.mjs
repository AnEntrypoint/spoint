
import { createAbilityTree } from '/workspace/spoint/src/game/AbilityTree.js';
const tree = createAbilityTree([{ id: 7, name: 'Fire', description: 'd', manaCost: 1, cooldown: 5, unlockLevel: 2, damage: 1 }], { 1: 7 });
const p = 'p1';
console.log(JSON.stringify({
  unknown: tree.canCastAbility(p, 99, 3),
  locked: tree.canCastAbility(p, 7, 1),
  ok: tree.canCastAbility(p, 7, 3),
  cast: tree.castAbility(p, 7, 3),
  cooling: tree.castAbility(p, 7, 3),
  badSlot: tree.bindHotkey(12, 7),
  badAbility: tree.bindHotkey(1, 99),
}));