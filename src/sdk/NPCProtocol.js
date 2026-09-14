export function validateNPCCommand(cmd) {
  if (!cmd || cmd.type !== 'npc') return { valid: false, error: 'expected type: "npc"' }
  if (typeof cmd.action !== 'string') return { valid: false, error: 'action is required' }
  if (typeof cmd.npcId !== 'string') return { valid: false, error: 'npcId is required' }
  return { valid: true }
}

export function buildNPCEvent(npcId, event, payload = {}) {
  return { type: 'npc-event', npcId, event, payload }
}

export const NPC_ACTIONS = [
  'npc.say',
  'npc.think',
  'npc.emote',
  'npc.goal',
  'npc.goal.clear',
  'npc.spawn',
  'npc.despawn',
]

export const NPC_EVENTS = [
  'npc.seen',
  'npc.interacted',
  'npc.goal.complete',
  'npc.goal.failed',
  'npc.damaged',
  'npc.worldstate',
]