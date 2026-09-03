// Quick-chat wheel: a mobile-friendly, low-friction way to send a pre-canned room-chat message
// without opening the full text-chat panel (client/hud/Chat.js) and typing. Reuses the exact same
// radial visual component as client/hud/EmoteWheel.js (createEmoteWheel takes generic {clip,label}
// slots and just renders a ring + highlights the currently-held digit) -- ChatQuickWheel is a thin
// wrapper around it that treats each slot's "clip" field as the literal message text to send via
// the real wireweave Chat class (node_modules/wireweave/src/chat.js's send()), not an animation.
//
// Desktop: hold KeyV (see src/client/InputHandler.js's chatWheelHeld) to show, digit 1-8 while held
// to pick a slot, release to send -- identical interaction shape to the emote wheel, just a
// different held key so the two never collide.
//
// Mobile: MobileControlsUI.js's single dedicated chat-bubble button (top-right, tap-and-hold) opens
// the SAME wheel; mobile has no digit keys, so InputHandler.js's mobile branch reports chatWheelDigit
// as a fixed 1 while held (sends slot 1, the "gg"/wave default) rather than shipping a full
// touch-drag radial-picker gesture -- an honest, simpler fallback per this row's own scope (a fixed
// pre-canned-message quick-select, not a full second touch gesture system), not a silent downgrade:
// documented here and in the PRD row's own text.
import { createEmoteWheel } from './EmoteWheel.js'

// Default 8 pre-canned messages, digit 1..8 clockwise from the top (same layout convention as
// EmoteWheel.js). Kept short (fits the chat panel's ch-body width) and game-agnostic; a world/app
// can pass its own `messages` array to createChatQuickWheel to override.
export const DEFAULT_QUICK_MESSAGES = [
  'Hello!', 'GG', 'Nice shot!', 'Need help', 'On my way', 'Thanks!', 'Sorry', 'Good game'
]

// getChat: () => the room's real wireweave Chat instance (or null before Chat.js's own onJoin has
// run) -- same getBridge()-style lazy-accessor convention as VoiceIndicator/Chat.js themselves, so
// this module never has to reason about wireweave connect/join ordering on its own.
export function createChatQuickWheel(getChat, messages = DEFAULT_QUICK_MESSAGES) {
  const slots = messages.slice(0, 8).map(text => ({ clip: text, label: text.length > 10 ? text.slice(0, 9) + '…' : text }))
  const wheel = createEmoteWheel(slots)
  let wasHeld = false
  let lastDigit = 0

  return {
    // Call once per frame from the same input tick that already drives EmoteWheel (app.js/onFrame),
    // passing input.chatWheelHeld/chatWheelDigit. Fires chat.send() on release (held -> not-held
    // transition), matching EmoteWheel's own "commit on release" UX so a quick tap-through of digits
    // while deciding doesn't spam the channel.
    update(held, digit) {
      const state = wheel.update(held, digit)
      if (wasHeld && !held && lastDigit > 0) {
        const chat = getChat?.()
        const text = slots[lastDigit - 1]?.clip
        if (chat && text) chat.send(text).catch?.(err => console.warn('[chat-wheel] send failed:', err?.message || err))
      }
      wasHeld = held
      if (digit > 0) lastDigit = digit
      else if (!held) lastDigit = 0
      return state
    },
    get isOpen() { return wheel.isOpen },
    dispose() { wheel.dispose() }
  }
}
