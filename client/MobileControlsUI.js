const CSS = `
@keyframes buttonPulse { 0% { transform: scale(1); } 50% { transform: scale(0.92); } 100% { transform: scale(1); } }
@keyframes joyGlow { 0% { box-shadow: 0 0 15px rgba(100,200,255,0.4),inset 0 0 20px rgba(100,200,255,0.1); } 100% { box-shadow: 0 0 25px rgba(100,200,255,0.6),inset 0 0 30px rgba(100,200,255,0.2); } }
@keyframes joyGlowLook { 0% { box-shadow: 0 0 15px rgba(255,150,100,0.4),inset 0 0 20px rgba(255,150,100,0.1); } 100% { box-shadow: 0 0 25px rgba(255,150,100,0.6),inset 0 0 30px rgba(255,150,100,0.2); } }
@keyframes fadeIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
.mobile-joystick-container { position: absolute; pointer-events: auto; touch-action: none; opacity: 0; animation: fadeIn 0.4s ease-out forwards; animation-delay: 0.1s; }
.mobile-joystick-base { position: absolute; width: 100%; height: 100%; border-radius: 50%; background: radial-gradient(circle at 30% 30%, rgba(60,80,100,0.5), rgba(20,30,40,0.7)); border: 2px solid rgba(150,200,255,0.25); box-shadow: 0 4px 20px rgba(0,0,0,0.4),inset 0 2px 10px rgba(255,255,255,0.05); transition: border-color 0.15s, box-shadow 0.15s; }
.mobile-joystick-base.active { border-color: rgba(100,200,255,0.6); animation: joyGlow 1.5s ease-in-out infinite; }
.mobile-joystick-base.look-active { border-color: rgba(255,180,100,0.6); animation: joyGlowLook 1.5s ease-in-out infinite; }
.mobile-joystick-knob { position: absolute; top: 50%; left: 50%; width: 56px; height: 56px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, rgba(180,200,220,0.6), rgba(100,130,160,0.5)); border: 2px solid rgba(200,220,255,0.4); transform: translate(-50%,-50%); box-shadow: 0 3px 12px rgba(0,0,0,0.3),inset 0 2px 6px rgba(255,255,255,0.2); transition: transform 0.05s ease-out, background 0.1s; }
.mobile-joystick-knob.active { background: radial-gradient(circle at 35% 35%, rgba(120,220,255,0.7), rgba(60,150,200,0.6)); border-color: rgba(150,220,255,0.7); }
.mobile-joystick-knob.look-active { background: radial-gradient(circle at 35% 35%, rgba(255,180,120,0.7), rgba(200,120,60,0.6)); border-color: rgba(255,200,150,0.7); }
.mobile-joystick-directions { position: absolute; width: 100%; height: 100%; pointer-events: none; opacity: 0.3; }
.mobile-joystick-directions span { position: absolute; font-size: 10px; color: rgba(200,220,255,0.6); font-weight: 600; }
.mobile-joystick-directions .dir-up { top: 8px; left: 50%; transform: translateX(-50%); }
.mobile-joystick-directions .dir-down { bottom: 8px; left: 50%; transform: translateX(-50%); }
.mobile-joystick-directions .dir-left { left: 8px; top: 50%; transform: translateY(-50%); }
.mobile-joystick-directions .dir-right { right: 8px; top: 50%; transform: translateY(-50%); }
.mobile-buttons-container { position: absolute; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; padding: 0; pointer-events: auto; opacity: 0; animation: fadeIn 0.4s ease-out forwards; animation-delay: 0.2s; }
.mobile-action-btn { border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.9); text-shadow: 0 1px 2px rgba(0,0,0,0.5); cursor: pointer; transition: all 0.08s ease-out; border: 2px solid rgba(200,220,255,0.3); box-shadow: 0 4px 15px rgba(0,0,0,0.35),inset 0 1px 3px rgba(255,255,255,0.15); user-select: none; -webkit-user-select: none; touch-action: none; }
.mobile-action-btn:active, .mobile-action-btn.active { transform: scale(0.92); border-color: rgba(255,255,255,0.6); }
.mobile-action-btn.primary { background: linear-gradient(145deg, rgba(255,100,80,0.7), rgba(200,60,50,0.7)); }
.mobile-action-btn.primary:active, .mobile-action-btn.primary.active { background: linear-gradient(145deg, rgba(255,130,100,0.85), rgba(230,80,70,0.85)); box-shadow: 0 2px 20px rgba(255,100,80,0.5),inset 0 1px 5px rgba(255,255,255,0.3); }
.mobile-action-btn.jump { background: linear-gradient(145deg, rgba(80,200,120,0.65), rgba(50,150,80,0.65)); }
.mobile-action-btn.jump:active, .mobile-action-btn.jump.active { background: linear-gradient(145deg, rgba(100,230,150,0.8), rgba(70,180,100,0.8)); box-shadow: 0 2px 20px rgba(80,200,120,0.4); }
.mobile-action-btn.sprint { background: linear-gradient(145deg, rgba(255,200,60,0.65), rgba(200,150,30,0.65)); }
.mobile-action-btn.sprint:active, .mobile-action-btn.sprint.active { background: linear-gradient(145deg, rgba(255,220,100,0.8), rgba(230,180,60,0.8)); box-shadow: 0 2px 20px rgba(255,200,60,0.4); }
.mobile-action-btn.crouch { background: linear-gradient(145deg, rgba(150,130,255,0.65), rgba(100,80,200,0.65)); }
.mobile-action-btn.crouch:active, .mobile-action-btn.crouch.active { background: linear-gradient(145deg, rgba(180,160,255,0.8), rgba(130,110,230,0.8)); box-shadow: 0 2px 20px rgba(150,130,255,0.4); }
.mobile-action-btn.reload { background: linear-gradient(145deg, rgba(100,180,255,0.65), rgba(60,130,200,0.65)); }
.mobile-action-btn.reload:active, .mobile-action-btn.reload.active { background: linear-gradient(145deg, rgba(130,210,255,0.8), rgba(90,160,230,0.8)); box-shadow: 0 2px 20px rgba(100,180,255,0.4); }
.mobile-action-btn.weapon { background: linear-gradient(145deg, rgba(255,150,50,0.65), rgba(200,100,30,0.65)); }
.mobile-action-btn.weapon:active, .mobile-action-btn.weapon.active { background: linear-gradient(145deg, rgba(255,180,100,0.8), rgba(230,130,60,0.8)); box-shadow: 0 2px 20px rgba(255,150,50,0.4); }
.mobile-action-btn .btn-icon { font-size: 18px; line-height: 1; }
.mobile-action-btn .btn-label { font-size: 9px; opacity: 0.8; margin-top: 2px; }
.mobile-action-btn.large .btn-icon { font-size: 24px; }
.mobile-zoom-controls { position: absolute; display: flex; flex-direction: row; gap: 8px; pointer-events: auto; opacity: 0; animation: fadeIn 0.4s ease-out forwards; animation-delay: 0.25s; }
.mobile-zoom-btn { border-radius: 12px; display: flex; align-items: center; justify-content: center; background: rgba(40,50,60,0.75); border: 2px solid rgba(150,200,255,0.25); color: rgba(200,220,255,0.8); font-size: 20px; box-shadow: 0 3px 12px rgba(0,0,0,0.3); transition: all 0.1s ease-out; }
.mobile-zoom-btn:active { background: rgba(60,80,100,0.85); border-color: rgba(150,200,255,0.5); transform: scale(0.92); }
.mobile-top-bar { position: absolute; top: 0; left: 0; right: 0; height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: linear-gradient(to bottom, rgba(0,0,0,0.4), transparent); pointer-events: none; opacity: 0; animation: fadeIn 0.4s ease-out forwards; }
.mobile-joystick-label { position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); font-size: 10px; color: rgba(200,220,255,0.5); font-weight: 600; text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; }
`

function injectStyle() {
  if (document.getElementById('mobile-controls-style')) return
  const style = document.createElement('style')
  style.id = 'mobile-controls-style'
  style.textContent = CSS
  document.head.appendChild(style)
}

function makeJoystick(id, directions, responsive) {
  const r = responsive.joystickRadius
  const d = r * 2
  const container = document.createElement('div')
  container.className = 'mobile-joystick-container'
  container.id = id + '-joystick'

  const base = document.createElement('div')
  base.className = 'mobile-joystick-base'
  base.id = id + '-joystick-base'

  const dirs = document.createElement('div')
  dirs.className = 'mobile-joystick-directions'
  dirs.innerHTML = directions

  const knob = document.createElement('div')
  knob.className = 'mobile-joystick-knob'
  knob.id = id + '-joystick-knob'

  base.appendChild(dirs)
  container.appendChild(base)
  container.appendChild(knob)
  return { container, knob, base }
}

function makeButton(id, icon, label, className, action, size) {
  const btn = document.createElement('div')
  btn.className = `mobile-action-btn ${className}`
  btn.dataset.action = action || id
  btn.style.cssText = `width: ${size}px; height: ${size}px;`
  const iconSpan = document.createElement('span')
  iconSpan.className = 'btn-icon'
  iconSpan.textContent = icon
  const labelSpan = document.createElement('span')
  labelSpan.className = 'btn-label'
  labelSpan.textContent = label
  btn.appendChild(iconSpan)
  btn.appendChild(labelSpan)
  return btn
}

export function createMobileControlsUI(controls) {
  if (!controls.enabled) return { show: () => {}, hide: () => {}, update: () => {}, destroy: () => {} }

  injectStyle()
  const { responsive, layout } = controls

  const container = document.createElement('div')
  container.id = 'mobile-controls'
  container.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden;'

  const { container: moveContainer, knob: moveKnob } = makeJoystick('move',
    '<span class="dir-up">W</span><span class="dir-down">S</span><span class="dir-left">A</span><span class="dir-right">D</span>',
    responsive)
  const moveLabel = document.createElement('div')
  moveLabel.className = 'mobile-joystick-label'
  moveLabel.textContent = 'MOVE'
  moveContainer.appendChild(moveLabel)
  moveContainer.style.cssText = `left:${layout.moveLeft}px;bottom:${layout.moveBottom}px;width:${responsive.joystickRadius*2}px;height:${responsive.joystickRadius*2}px;`

  const { container: lookContainer, knob: lookKnob } = makeJoystick('look',
    '<span class="dir-up">↑</span><span class="dir-down">↓</span><span class="dir-left">←</span><span class="dir-right">→</span>',
    responsive)
  const lookLabel = document.createElement('div')
  lookLabel.className = 'mobile-joystick-label'
  lookLabel.textContent = 'LOOK'
  lookContainer.appendChild(lookLabel)
  lookContainer.style.cssText = `right:${layout.lookRight}px;bottom:${layout.lookBottom}px;width:${responsive.joystickRadius*2}px;height:${responsive.joystickRadius*2}px;`

  const buttonsContainer = document.createElement('div')
  buttonsContainer.style.cssText = `position:absolute;bottom:${layout.buttonsBottomOffset}px;right:${layout.buttonsRightOffset}px;pointer-events:auto;z-index:9999;`

  const diamond = document.createElement('div')
  diamond.style.cssText = 'display:grid!important;grid-template-columns:repeat(3,auto);grid-template-rows:repeat(3,auto);gap:12px;align-items:center;justify-items:center;'

  const bs = responsive.buttonSize
  const pbs = responsive.primaryButtonSize
  const jumpBtn = makeButton('jump', 'A', 'JUMP', 'jump', 'jump', bs)
  jumpBtn.style.cssText += ';grid-column:2;grid-row:3;'
  const crouchBtn = makeButton('crouch', 'X', 'CROUCH', 'crouch', 'crouch', bs)
  crouchBtn.style.cssText += ';grid-column:1;grid-row:2;'
  const shootBtn = makeButton('shoot', 'B', 'SHOOT', 'weapon', 'shoot', bs)
  shootBtn.style.cssText += ';grid-column:3;grid-row:2;'
  const useBtn = makeButton('use', 'Y', 'RELOAD', 'reload', 'reload', bs)
  useBtn.style.cssText += ';grid-column:2;grid-row:1;'

  diamond.appendChild(crouchBtn)
  diamond.appendChild(jumpBtn)
  diamond.appendChild(useBtn)
  diamond.appendChild(shootBtn)
  buttonsContainer.appendChild(diamond)

  const zoomRight = layout.lookRight + responsive.joystickRadius
  const zoomContainer = document.createElement('div')
  zoomContainer.className = 'mobile-zoom-controls'
  zoomContainer.style.cssText = `bottom:${responsive.bottomMargin}px;right:${zoomRight}px;transform:translateX(50%);`
  const zoomSize = Math.max(40, bs * 0.8)
  const zoomInBtn = document.createElement('div')
  zoomInBtn.className = 'mobile-zoom-btn'
  zoomInBtn.textContent = '+'
  zoomInBtn.dataset.action = 'zoomIn'
  zoomInBtn.style.cssText = `width:${zoomSize}px;height:${zoomSize}px;`
  const zoomOutBtn = document.createElement('div')
  zoomOutBtn.className = 'mobile-zoom-btn'
  zoomOutBtn.textContent = '−'
  zoomOutBtn.dataset.action = 'zoomOut'
  zoomOutBtn.style.cssText = `width:${zoomSize}px;height:${zoomSize}px;`
  zoomContainer.appendChild(zoomInBtn)
  zoomContainer.appendChild(zoomOutBtn)

  const topBar = document.createElement('div')
  topBar.className = 'mobile-top-bar'

  container.appendChild(moveContainer)
  container.appendChild(lookContainer)
  container.appendChild(buttonsContainer)
  container.appendChild(zoomContainer)
  container.appendChild(topBar)
  document.body.appendChild(container)

  controls.buttons.set('jump', jumpBtn)
  controls.buttons.set('crouch', crouchBtn)
  controls.buttons.set('shoot', shootBtn)
  controls.buttons.set('use', useBtn)
  controls.buttons.set('zoomIn', zoomInBtn)
  controls.buttons.set('zoomOut', zoomOutBtn)

  controls.setUICallbacks({
    onShow: () => { container.style.display = 'block' },
    onHide: () => { container.style.display = 'none' },
    onEnabledChanged: (enabled) => { container.style.display = enabled ? 'block' : 'none' },
    onMoveJoystickStart: (x, y, r) => {
      moveContainer.style.left = `${x - r}px`
      moveContainer.style.top = `${y - r}px`
      moveContainer.style.bottom = 'auto'
      document.getElementById('move-joystick-base')?.classList.add('active')
      moveKnob.classList.add('active')
    },
    onMoveJoystickMove: (dx, dy) => {
      moveKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
    },
    onMoveJoystickEnd: (moveLeft, moveBottom) => {
      moveKnob.style.transform = 'translate(-50%, -50%)'
      moveKnob.classList.remove('active')
      document.getElementById('move-joystick-base')?.classList.remove('active')
      moveContainer.style.left = `${moveLeft}px`
      moveContainer.style.bottom = `${moveBottom}px`
      moveContainer.style.top = 'auto'
    },
    onLookJoystickStart: (x, y) => {
      document.getElementById('look-joystick-base')?.classList.add('look-active')
      lookKnob.classList.add('look-active')
      const rect = lookContainer.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    },
    onLookJoystickMove: (lx, ly) => {
      lookKnob.style.transform = `translate(calc(-50% + ${lx}px), calc(-50% + ${ly}px))`
    },
    onLookJoystickEnd: () => {
      lookKnob.style.transform = 'translate(-50%, -50%)'
      lookKnob.classList.remove('look-active')
      document.getElementById('look-joystick-base')?.classList.remove('look-active')
    },
    onInteractablesChanged: (interactableTargets) => {
      const hasInteractables = interactableTargets.size > 0
      const label = hasInteractables ? 'USE' : 'RELOAD'
      const action = hasInteractables ? 'interact' : 'reload'
      useBtn.dataset.action = action
      useBtn.className = `mobile-action-btn ${action}`
      const labelSpan = useBtn.querySelector('.btn-label')
      if (labelSpan) labelSpan.textContent = label
    },
    onLayoutUpdate: (layout, responsive) => {
      const r = responsive.joystickRadius
      const d = r * 2
      moveContainer.style.left = `${layout.moveLeft}px`
      moveContainer.style.bottom = `${layout.moveBottom}px`
      moveContainer.style.width = `${d}px`
      moveContainer.style.height = `${d}px`
      lookContainer.style.right = `${layout.lookRight}px`
      lookContainer.style.bottom = `${layout.lookBottom}px`
      lookContainer.style.width = `${d}px`
      lookContainer.style.height = `${d}px`
      buttonsContainer.style.bottom = `${layout.buttonsBottomOffset}px`
      buttonsContainer.style.right = `${layout.buttonsRightOffset}px`
      const zr = layout.lookRight + r
      zoomContainer.style.bottom = `${responsive.bottomMargin}px`
      zoomContainer.style.right = `${zr}px`
      zoomContainer.style.transform = 'translateX(50%)'
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
    destroy: () => { controls.destroy() }
  }
}
