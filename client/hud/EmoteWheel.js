import { ensureStyle } from './ensureStyle.js'
const CSS = `
#emote-wheel-overlay {
  position: fixed; inset: 0; z-index: 10600;
  display: none; align-items: center; justify-content: center;
  pointer-events: none; font: 12px var(--ff-mono, monospace);
}
#emote-wheel-overlay.open { display: flex; }
#emote-wheel-ring { position: relative; width: 260px; height: 260px; }
.ew-slot {
  position: absolute; width: 76px; height: 76px; margin: -38px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  background: color-mix(in oklab, var(--panel-1, #050b12) 88%, transparent);
  border: 1px solid var(--rule, rgba(0,210,255,0.3));
  border-radius: 50%; color: var(--panel-text, #fff); text-align: center;
  transition: transform 0.1s, border-color 0.1s, background 0.1s;
}
.ew-slot.active { border-color: var(--accent, #00d2ff); background: color-mix(in oklab, var(--accent, #00d2ff) 25%, var(--panel-1, #050b12)); transform: scale(1.12); }
.ew-slot .ew-digit { font-size: 10px; opacity: 0.6; }
.ew-slot .ew-label { font-size: 11px; font-weight: 600; }
#emote-wheel-center {
  position: absolute; left: 50%; top: 50%; margin: -20px; width: 40px; height: 40px;
  border-radius: 50%; background: color-mix(in oklab, var(--panel-1, #050b12) 92%, transparent);
  border: 1px solid var(--rule, rgba(0,210,255,0.2));
}
`

const RADIUS = 100
const SLOT0_AT_TOP_ANGLE_OFFSET = Math.PI / 2

export function createEmoteWheel(slots) {
  ensureStyle('emote-wheel-style', CSS)
  const overlay = document.createElement('div')
  overlay.id = 'emote-wheel-overlay'
  const ring = document.createElement('div')
  ring.id = 'emote-wheel-ring'
  overlay.appendChild(ring)
  const center = document.createElement('div')
  center.id = 'emote-wheel-center'
  ring.appendChild(center)

  const slotEls = slots.slice(0, 8).map((s, i) => {
    const angle = (i / slots.length) * Math.PI * 2 - SLOT0_AT_TOP_ANGLE_OFFSET
    const x = 130 + Math.cos(angle) * RADIUS, y = 130 + Math.sin(angle) * RADIUS
    const el = document.createElement('div')
    el.className = 'ew-slot'
    el.style.left = x + 'px'; el.style.top = y + 'px'
    const digitEl = document.createElement('div'); digitEl.className = 'ew-digit'; digitEl.textContent = String(i + 1)
    const labelEl = document.createElement('div'); labelEl.className = 'ew-label'; labelEl.textContent = s.label
    el.appendChild(digitEl); el.appendChild(labelEl)
    ring.appendChild(el)
    return el
  })

  document.body.appendChild(overlay)

  let selection = null

  return {
    update(held, digit) {
      if (held && !selection) {
        overlay.classList.add('open')
        selection = { digit: 0 }
      }
      if (selection && digit !== selection.digit) {
        if (selection.digit > 0 && slotEls[selection.digit - 1]) slotEls[selection.digit - 1].classList.remove('active')
        if (digit > 0 && slotEls[digit - 1]) slotEls[digit - 1].classList.add('active')
        selection.digit = digit
      }
      if (!held && selection) {
        const released = selection.digit
        if (released > 0 && slotEls[released - 1]) slotEls[released - 1].classList.remove('active')
        overlay.classList.remove('open')
        selection = null
        return { open: false, digit: released, clip: released > 0 && slots[released - 1] ? slots[released - 1].clip : null }
      }
      const active = selection ? selection.digit : 0
      return { open: selection !== null, digit: active, clip: active > 0 && slots[active - 1] ? slots[active - 1].clip : null }
    },
    get isOpen() { return selection !== null },
    dispose() { overlay.remove() },
  }
}

// --- hot swap -----
// An edit here is accepted by this module: every export is re-assigned to the freshly imported copy,
// so importers already holding the live binding read the edited code without a page reload.
const _hotSwapExports = (next) => {
  createEmoteWheel = next.createEmoteWheel
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapExports)
