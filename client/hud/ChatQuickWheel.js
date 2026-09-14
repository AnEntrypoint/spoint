import { createEmoteWheel } from './EmoteWheel.js'

export const DEFAULT_QUICK_MESSAGES = [
  'Hello!', 'GG', 'Nice shot!', 'Need help', 'On my way', 'Thanks!', 'Sorry', 'Good game'
]

export function createChatQuickWheel(getChat, messages = DEFAULT_QUICK_MESSAGES) {
  const slots = messages.slice(0, 8).map(text => ({ clip: text, label: text.length > 10 ? text.slice(0, 9) + '…' : text }))
  const wheel = createEmoteWheel(slots)
  let wasHeld = false
  let lastDigit = 0

  return {
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
