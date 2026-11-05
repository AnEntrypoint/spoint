import { createAbilityTree, DEFAULT_ABILITIES } from '/workspace/spoint/src/game/AbilityTree.js';
const t = createAbilityTree();
const id = DEFAULT_ABILITIES[0].id;
const out = { slotOut: t.bindHotkey(99, id), unknown: t.bindHotkey(1, 'no-such-ability-xyz') };
console.log(JSON.stringify(out));