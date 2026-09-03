// Emote/gesture wheel: hold the bound key (default B, see InputHandler.js's emoteWheelHeld) to show
// up to 8 radial slots; press the matching digit (1-8) to select and play. Plain DOM overlay, same
// doctrine as PauseMenu.js/SettingsMenu.js -- renders reliably regardless of ui-root diff churn.
// Purely a LOCAL selection UI: the caller (app onInput) is the one that actually calls
// ctx.players.playAnimation / engine.client's own emote-send path once a slot is chosen; this module
// owns only visibility + the visual radial layout + reporting which digit is currently highlighted.

function ensureStyles() {
  if (document.getElementById('emote-wheel-style')) return
  const style = document.createElement('style')
  style.id = 'emote-wheel-style'
  style.textContent = `
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
  document.head.appendChild(style)
}

const RADIUS = 100

// slots: array of up to 8 { clip, label } -- clip is the real animation clip name passed to
// AnimationStateMachine.play (this session's own new emote-play primitive), label is the maker-facing
// wheel text. Layout order = digit 1..N clockwise starting at the top, matching InputHandler.js's
// emoteDigit binding 1:1 so the on-screen position a maker sees for slot N is exactly the digit that
// selects it.
export function createEmoteWheel(slots) {
  ensureStyles()
  const overlay = document.createElement('div')
  overlay.id = 'emote-wheel-overlay'
  const ring = document.createElement('div')
  ring.id = 'emote-wheel-ring'
  overlay.appendChild(ring)
  const center = document.createElement('div')
  center.id = 'emote-wheel-center'
  ring.appendChild(center)

  const slotEls = slots.slice(0, 8).map((s, i) => {
    const angle = (i / slots.length) * Math.PI * 2 - Math.PI / 2 // slot 0 (digit 1) at the top, clockwise
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

  let _open = false
  let _activeDigit = 0

  return {
    // Call once per frame from onFrame with the live input.emoteWheelHeld/emoteDigit -- returns the
    // currently-selected slot (or null) so the caller decides when to actually fire the emote (on
    // release, matching a real radial-wheel UX where the pick commits when the key is let go, not on
    // every held frame -- avoids re-triggering the same emote 60x/sec while a digit stays held).
    update(held, digit) {
      if (held && !_open) { overlay.classList.add('open'); _open = true }
      else if (!held && _open) { overlay.classList.remove('open'); _open = false }
      if (digit !== _activeDigit) {
        if (_activeDigit > 0 && slotEls[_activeDigit - 1]) slotEls[_activeDigit - 1].classList.remove('active')
        if (digit > 0 && slotEls[digit - 1]) slotEls[digit - 1].classList.add('active')
        _activeDigit = digit
      }
      return { open: _open, digit: _activeDigit, clip: (_activeDigit > 0 && slots[_activeDigit - 1]) ? slots[_activeDigit - 1].clip : null }
    },
    get isOpen() { return _open },
    dispose() { overlay.remove() },
  }
}
