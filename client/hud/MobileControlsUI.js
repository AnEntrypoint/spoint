// Mobile touch overlay using anentrypoint-design kit primitives. All colors come from
// kit CSS variables (var(--accent), var(--panel-1), --panel-text, --rule) — no inline
// rgba() or hardcoded hex. Touch targets ≥44px via pointer-coarse media query.
const CSS = `
@keyframes joyGlow{0%{box-shadow:0 0 15px color-mix(in oklab, var(--accent) 40%, transparent),inset 0 0 20px color-mix(in oklab, var(--accent) 10%, transparent)}100%{box-shadow:0 0 25px color-mix(in oklab, var(--accent) 60%, transparent),inset 0 0 30px color-mix(in oklab, var(--accent) 20%, transparent)}}
@keyframes joyGlowLook{0%{box-shadow:0 0 15px color-mix(in oklab, var(--accent) 35%, transparent),inset 0 0 20px color-mix(in oklab, var(--accent) 8%, transparent)}100%{box-shadow:0 0 25px color-mix(in oklab, var(--accent) 55%, transparent),inset 0 0 30px color-mix(in oklab, var(--accent) 18%, transparent)}}
@keyframes fadeIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
.mobile-joystick-container{position:absolute;pointer-events:auto;touch-action:none;opacity:0;animation:fadeIn .4s ease-out forwards;animation-delay:.1s;padding:0;background:transparent;border:0}
.mobile-joystick-base{position:absolute;width:100%;height:100%;border-radius:50%;background:transparent;border:1px solid color-mix(in oklab, var(--rule) 50%, transparent);box-shadow:0 2px 10px color-mix(in oklab, var(--panel-text) 8%, transparent),inset 0 1px 5px color-mix(in oklab, var(--panel-text) 4%, transparent);transition:border-color .15s,box-shadow .15s}
.mobile-joystick-base.active{border-color:color-mix(in oklab, var(--accent) 70%, transparent);animation:joyGlow 1.5s ease-in-out infinite}
.mobile-joystick-base.look-active{border-color:color-mix(in oklab, var(--accent) 60%, transparent);animation:joyGlowLook 1.5s ease-in-out infinite}
.mobile-joystick-knob{position:absolute;top:50%;left:50%;width:40px;height:40px;border-radius:50%;background:radial-gradient(circle at 35% 35%, color-mix(in oklab, var(--panel-text) 30%, transparent), color-mix(in oklab, var(--panel-text-3) 40%, transparent));border:1px solid color-mix(in oklab, var(--panel-text) 30%, transparent);transform:translate(-50%,-50%);box-shadow:0 2px 8px color-mix(in oklab, var(--panel-text) 8%, transparent),inset 0 1px 4px color-mix(in oklab, var(--panel-text) 15%, transparent);transition:transform .05s ease-out,background .1s}
.mobile-joystick-knob.active{background:radial-gradient(circle at 35% 35%, color-mix(in oklab, var(--accent) 70%, transparent), color-mix(in oklab, var(--accent) 50%, transparent));border-color:color-mix(in oklab, var(--accent) 70%, transparent)}
.mobile-joystick-knob.look-active{background:radial-gradient(circle at 35% 35%, color-mix(in oklab, var(--accent) 65%, transparent), color-mix(in oklab, var(--accent) 50%, transparent));border-color:color-mix(in oklab, var(--accent) 70%, transparent)}
.mobile-joystick-directions{position:absolute;width:100%;height:100%;pointer-events:none;opacity:.3}
.mobile-joystick-directions span{position:absolute;font-size:10px;color:var(--panel-text-2);font-weight:600;font-family:var(--ff-mono, ui-monospace, monospace)}
.mobile-joystick-directions .dir-up{top:8px;left:50%;transform:translateX(-50%)}
.mobile-joystick-directions .dir-down{bottom:8px;left:50%;transform:translateX(-50%)}
.mobile-joystick-directions .dir-left{left:8px;top:50%;transform:translateY(-50%)}
.mobile-joystick-directions .dir-right{right:8px;top:50%;transform:translateY(-50%)}
.mobile-action-btn{border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:700;text-shadow:0 1px 2px color-mix(in oklab, var(--panel-text) 30%, transparent);cursor:pointer;transition:transform .08s ease-out, box-shadow .12s, border-color .12s;user-select:none;-webkit-user-select:none;touch-action:none;padding:0}
.mobile-action-btn:active,.mobile-action-btn.active{transform:scale(.92);border-color:color-mix(in oklab, var(--accent) 80%, transparent)}
.mobile-action-btn .btn-icon{font-size:18px;line-height:1}
.mobile-action-btn .btn-label{font-size:9px;opacity:.85;margin-top:2px}
.mobile-zoom-controls{position:absolute;display:flex;flex-direction:column;gap:4px;pointer-events:auto;opacity:0;animation:fadeIn .4s ease-out forwards;animation-delay:.25s}
.mobile-zoom-btn{display:flex;align-items:center;justify-content:center;font-size:14px;font-family:var(--ff-mono, ui-monospace, monospace);padding:4px 8px;border-radius:6px;background:color-mix(in oklab, var(--panel-1) 80%, transparent);border:1px solid color-mix(in oklab, var(--rule) 50%, transparent);color:var(--panel-text);min-width:36px;min-height:36px}
.mobile-zoom-btn:active{transform:scale(.92);background:color-mix(in oklab, var(--panel-2) 80%, transparent)}
.mobile-top-bar{position:absolute;top:0;left:0;right:0;height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 20px 0 max(20px, env(safe-area-inset-left));background:linear-gradient(to bottom, color-mix(in oklab, var(--panel-text) 25%, transparent), transparent);pointer-events:none;opacity:0;animation:fadeIn .4s ease-out forwards}
.mobile-joystick-label{position:absolute;bottom:-24px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--panel-text-3);font-weight:600;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;font-family:var(--ff-mono, ui-monospace, monospace)}
/* Safe-area insets — keep controls clear of notch & home indicator */
#mobile-controls{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
/* pointer-coarse touch-target floor: 44px */
@media (pointer: coarse){
  .mobile-action-btn,.mobile-zoom-btn{min-width:44px;min-height:44px}
}
/* prefers-reduced-motion: kill the decorative glow/fade-in loops for players who've asked the OS
   to minimize motion; the controls stay fully functional, just static (no animated box-shadow pulse,
   no scale-in fade). */
@media (prefers-reduced-motion: reduce){
  .mobile-joystick-container{animation:none !important;opacity:1}
  .mobile-joystick-base.active,.mobile-joystick-base.look-active{animation:none !important}
  .mobile-zoom-controls{animation:none !important;opacity:1}
  .mobile-action-btn,.mobile-action-btn:active,.mobile-action-btn.active{transition:none !important;transform:none !important}
  .mobile-top-bar{animation:none !important;opacity:1}
}
`

function injectStyle() {
  if (document.getElementById('mobile-controls-style')) return
  const s = document.createElement('style')
  s.id = 'mobile-controls-style'
  s.textContent = CSS
  document.head.appendChild(s)
}

function makeJoystick(id, dirs) {
  const container = document.createElement('div')
  container.className = 'mobile-joystick-container panel'
  container.id = id + '-joystick'
  const base = document.createElement('div')
  base.className = 'mobile-joystick-base'
  base.id = id + '-joystick-base'
  const dirsEl = document.createElement('div')
  dirsEl.className = 'mobile-joystick-directions'
  dirsEl.innerHTML = dirs
  const knob = document.createElement('div')
  knob.className = 'mobile-joystick-knob'
  knob.id = id + '-joystick-knob'
  const label = document.createElement('div')
  label.className = 'mobile-joystick-label'
  label.textContent = id.toUpperCase()
  base.appendChild(dirsEl)
  container.appendChild(base)
  container.appendChild(knob)
  container.appendChild(label)
  return { container, knob, base }
}

// Map action kind -> kit button variant.
const VARIANT = {
  jump: 'btn-primary',
  shoot: 'btn-primary',
  reload: 'btn-primary',
  interact: 'btn-primary',
  crouch: 'btn-ghost',
  weapon: 'btn-primary'
}

function makeButton(id, icon, label, cls, action, size) {
  const btn = document.createElement('button')
  const variant = VARIANT[cls] || 'btn-primary'
  btn.className = `btn ${variant} mobile-action-btn ${cls}`
  btn.dataset.action = action || id
  btn.style.width = `${size}px`
  btn.style.height = `${size}px`
  btn.innerHTML = `<span class="btn-icon">${icon}</span><span class="btn-label">${label}</span>`
  return btn
}

export function createMobileControlsUI(controls) {
  if (!controls.enabled) return { show: () => {}, hide: () => {}, update: () => {}, destroy: () => {} }

  injectStyle()
  const { responsive: res, layout: lay } = controls
  const r = res.joystickRadius, d = r * 2, bs = res.buttonSize

  const container = document.createElement('div')
  container.id = 'mobile-controls'
  container.className = 'ds-247420'
  container.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden;'

  // Move joystick - minimal visual (just base ring + knob, no directions/label)
  const moveEl = document.createElement('div')
  moveEl.className = 'mobile-joystick-container'
  moveEl.id = 'move-joystick'
  moveEl.style.left = `${lay.moveLeft}px`
  moveEl.style.bottom = `${lay.moveBottom}px`
  moveEl.style.width = `${d}px`
  moveEl.style.height = `${d}px`
  const moveBase = document.createElement('div')
  moveBase.className = 'mobile-joystick-base'
  moveBase.id = 'move-joystick-base'
  const moveKnob = document.createElement('div')
  moveKnob.className = 'mobile-joystick-knob'
  moveKnob.id = 'move-joystick-knob'
  moveBase.appendChild(moveKnob)
  moveEl.appendChild(moveBase)

  // Look joystick - minimal invisible touch area (no visual base/knob/directions)
  const lookEl = document.createElement('div')
  lookEl.className = 'mobile-joystick-container'
  lookEl.id = 'look-joystick'
  lookEl.style.right = `${lay.lookRight}px`
  lookEl.style.bottom = `${lay.lookBottom}px`
  lookEl.style.width = `${d}px`
  lookEl.style.height = `${d}px`
  lookEl.style.background = 'transparent'
  lookEl.style.border = 'none'
  lookEl.style.boxShadow = 'none'

  // Action button cluster (kit Row-style grid).
  const btnsEl = document.createElement('div')
  btnsEl.className = 'row'
  btnsEl.style.cssText = `position:absolute;bottom:${lay.buttonsBottomOffset}px;right:${lay.buttonsRightOffset}px;pointer-events:auto;z-index:9999;display:grid;grid-template-columns:repeat(3,auto);grid-template-rows:repeat(3,auto);gap:12px;align-items:center;justify-items:center;padding:0;background:transparent;border:0;`

  const jumpBtn = makeButton('jump', 'A', 'JUMP', 'jump', 'jump', bs)
  jumpBtn.style.gridColumn = '2'; jumpBtn.style.gridRow = '3'
  const crouchBtn = makeButton('crouch', 'X', 'CROUCH', 'crouch', 'crouch', bs)
  crouchBtn.style.gridColumn = '1'; crouchBtn.style.gridRow = '2'
  const shootBtn = makeButton('shoot', 'B', 'SHOOT', 'weapon', 'shoot', bs)
  shootBtn.style.gridColumn = '3'; shootBtn.style.gridRow = '2'
  const useBtn = makeButton('use', 'Y', 'RELOAD', 'reload', 'reload', bs)
  useBtn.style.gridColumn = '2'; useBtn.style.gridRow = '1'

  btnsEl.appendChild(crouchBtn)
  btnsEl.appendChild(jumpBtn)
  btnsEl.appendChild(useBtn)
  btnsEl.appendChild(shootBtn)

  // Zoom controls - top center, small buttons
  const zoomEl = document.createElement('div')
  zoomEl.className = 'mobile-zoom-controls'
  zoomEl.style.cssText = `top:8px;left:50%;transform:translateX(-50%);pointer-events:auto;z-index:9999;display:flex;flex-direction:column;gap:4px;align-items:center;`
  const zs = 36
  const mkZoom = (sym, action) => {
    const b = document.createElement('button')
    b.className = 'btn btn-ghost mobile-zoom-btn'
    b.textContent = sym
    b.dataset.action = action
    b.style.width = `${zs}px`
    b.style.height = `${zs}px`
    return b
  }
  const zoomInBtn = mkZoom('+', 'zoomIn')
  const zoomOutBtn = mkZoom('-', 'zoomOut')
  zoomEl.appendChild(zoomInBtn)
  zoomEl.appendChild(zoomOutBtn)

  const topBar = document.createElement('div')
  topBar.className = 'mobile-top-bar'

  // Quick-chat wheel trigger: a single small top-bar button (topBar itself is pointer-events:none,
  // so this one child opts back in) since desktop's equivalent is a HELD key (see InputHandler.js's
  // chatWheelHeld/KeyV) but mobile has no free real estate for a second joystick-adjacent button --
  // the move/look joysticks + action-button cluster already fill both bottom corners. Tap-and-hold
  // opens client/hud/ChatQuickWheel.js the same as holding V does on desktop; released = send slot 1
  // (mobile has no digit keys to pick a different slot, see InputHandler.js's mobile chatWheelDigit).
  const chatWheelBtn = document.createElement('button')
  chatWheelBtn.className = 'btn btn-ghost mobile-action-btn chatWheel'
  chatWheelBtn.dataset.action = 'chatWheel'
  const cwSize = Math.max(40, bs * 0.75)
  chatWheelBtn.style.cssText = `position:absolute;top:8px;right:max(8px, env(safe-area-inset-right));width:${cwSize}px;height:${cwSize}px;pointer-events:auto;`
  chatWheelBtn.innerHTML = `<span class="btn-icon">💬</span>`
  topBar.appendChild(chatWheelBtn)

  container.appendChild(moveEl)
  container.appendChild(lookEl)
  container.appendChild(btnsEl)
  container.appendChild(zoomEl)
  container.appendChild(topBar)
  document.body.appendChild(container)

  controls.buttons.set('jump', jumpBtn)
  controls.buttons.set('crouch', crouchBtn)
  controls.buttons.set('shoot', shootBtn)
  controls.buttons.set('use', useBtn)
  controls.buttons.set('zoomIn', zoomInBtn)
  controls.buttons.set('zoomOut', zoomOutBtn)
  controls.buttons.set('chatWheel', chatWheelBtn)

  controls.setUICallbacks({
    onShow: () => { container.style.display = 'block' },
    onHide: () => { container.style.display = 'none' },
    onEnabledChanged: v => { container.style.display = v ? 'block' : 'none' },
    onMoveJoystickStart: (x, y, jr) => {
      moveEl.style.left = `${x - jr}px`
      moveEl.style.top = `${y - jr}px`
      moveEl.style.bottom = 'auto'
      document.getElementById('move-joystick-base')?.classList.add('active')
      moveKnob.classList.add('active')
    },
    onMoveJoystickMove: (dx, dy) => { moveKnob.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))` },
    onMoveJoystickEnd: (ml, mb) => {
      moveKnob.style.transform = 'translate(-50%,-50%)'
      moveKnob.classList.remove('active')
      document.getElementById('move-joystick-base')?.classList.remove('active')
      moveEl.style.left = `${ml}px`
      moveEl.style.bottom = `${mb}px`
      moveEl.style.top = 'auto'
    },
    onLookJoystickStart: (x, y) => {
      const rect = lookEl.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    },
    onLookJoystickMove: (lx, ly) => { },
    onLookJoystickEnd: () => { },
    onInteractablesChanged: targets => {
      const has = targets.size > 0
      useBtn.dataset.action = has ? 'interact' : 'reload'
      const variant = VARIANT[has ? 'interact' : 'reload'] || 'btn-primary'
      useBtn.className = `btn ${variant} mobile-action-btn ${has ? 'interact' : 'reload'}`
      const lbl = useBtn.querySelector('.btn-label')
      if (lbl) lbl.textContent = has ? 'USE' : 'RELOAD'
    },
    onLayoutUpdate: (l, rsp) => {
      const rd = rsp.joystickRadius, rdd = rd * 2
      moveEl.style.left = `${l.moveLeft}px`; moveEl.style.bottom = `${l.moveBottom}px`
      moveEl.style.width = `${rdd}px`; moveEl.style.height = `${rdd}px`; moveEl.style.top = 'auto'
      lookEl.style.right = `${l.lookRight}px`; lookEl.style.bottom = `${l.lookBottom}px`
      lookEl.style.width = `${rdd}px`; lookEl.style.height = `${rdd}px`; lookEl.style.top = 'auto'
      btnsEl.style.bottom = `${l.buttonsBottomOffset}px`
      btnsEl.style.right = `${l.buttonsRightOffset}px`
      zoomEl.style.top = '8px'
      zoomEl.style.left = '50%'
      zoomEl.style.transform = 'translateX(-50%)'
    },
    onDestroy: () => {
      container.remove()
      document.getElementById('mobile-controls-style')?.remove()
    }
  })

  return {
    show: () => controls.show(),
    hide: () => controls.hide(),
    update: () => {},
    destroy: () => controls.destroy()
  }
}
