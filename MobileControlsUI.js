const CSS = '@keyframes joyGlow{0%{box-shadow:0 0 15px rgba(100,200,255,.4),inset 0 0 20px rgba(100,200,255,.1)}100%{box-shadow:0 0 25px rgba(100,200,255,.6),inset 0 0 30px rgba(100,200,255,.2)}}@keyframes joyGlowLook{0%{box-shadow:0 0 15px rgba(255,150,100,.4),inset 0 0 20px rgba(255,150,100,.1)}100%{box-shadow:0 0 25px rgba(255,150,100,.6),inset 0 0 30px rgba(255,150,100,.2)}}@keyframes fadeIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}.mobile-joystick-container{position:absolute;pointer-events:auto;touch-action:none;opacity:0;animation:fadeIn .4s ease-out forwards;animation-delay:.1s}.mobile-joystick-base{position:absolute;width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 30% 30%,rgba(60,80,100,.5),rgba(20,30,40,.7));border:2px solid rgba(150,200,255,.25);box-shadow:0 4px 20px rgba(0,0,0,.4),inset 0 2px 10px rgba(255,255,255,.05);transition:border-color .15s,box-shadow .15s}.mobile-joystick-base.active{border-color:rgba(100,200,255,.6);animation:joyGlow 1.5s ease-in-out infinite}.mobile-joystick-base.look-active{border-color:rgba(255,180,100,.6);animation:joyGlowLook 1.5s ease-in-out infinite}.mobile-joystick-knob{position:absolute;top:50%;left:50%;width:56px;height:56px;border-radius:50%;background:radial-gradient(circle at 35% 35%,rgba(180,200,220,.6),rgba(100,130,160,.5));border:2px solid rgba(200,220,255,.4);transform:translate(-50%,-50%);box-shadow:0 3px 12px rgba(0,0,0,.3),inset 0 2px 6px rgba(255,255,255,.2);transition:transform .05s ease-out,background .1s}.mobile-joystick-knob.active{background:radial-gradient(circle at 35% 35%,rgba(120,220,255,.7),rgba(60,150,200,.6));border-color:rgba(150,220,255,.7)}.mobile-joystick-knob.look-active{background:radial-gradient(circle at 35% 35%,rgba(255,180,120,.7),rgba(200,120,60,.6));border-color:rgba(255,200,150,.7)}.mobile-joystick-directions{position:absolute;width:100%;height:100%;pointer-events:none;opacity:.3}.mobile-joystick-directions span{position:absolute;font-size:10px;color:rgba(200,220,255,.6);font-weight:600}.mobile-joystick-directions .dir-up{top:8px;left:50%;transform:translateX(-50%)}.mobile-joystick-directions .dir-down{bottom:8px;left:50%;transform:translateX(-50%)}.mobile-joystick-directions .dir-left{left:8px;top:50%;transform:translateY(-50%)}.mobile-joystick-directions .dir-right{right:8px;top:50%;transform:translateY(-50%)}.mobile-action-btn{border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:rgba(255,255,255,.9);text-shadow:0 1px 2px rgba(0,0,0,.5);cursor:pointer;transition:all .08s ease-out;border:2px solid rgba(200,220,255,.3);box-shadow:0 4px 15px rgba(0,0,0,.35),inset 0 1px 3px rgba(255,255,255,.15);user-select:none;-webkit-user-select:none;touch-action:none}.mobile-action-btn:active,.mobile-action-btn.active{transform:scale(.92);border-color:rgba(255,255,255,.6)}.mobile-action-btn.jump{background:linear-gradient(145deg,rgba(80,200,120,.65),rgba(50,150,80,.65))}.mobile-action-btn.jump:active,.mobile-action-btn.jump.active{background:linear-gradient(145deg,rgba(100,230,150,.8),rgba(70,180,100,.8));box-shadow:0 2px 20px rgba(80,200,120,.4)}.mobile-action-btn.crouch{background:linear-gradient(145deg,rgba(150,130,255,.65),rgba(100,80,200,.65))}.mobile-action-btn.crouch:active,.mobile-action-btn.crouch.active{background:linear-gradient(145deg,rgba(180,160,255,.8),rgba(130,110,230,.8));box-shadow:0 2px 20px rgba(150,130,255,.4)}.mobile-action-btn.reload{background:linear-gradient(145deg,rgba(100,180,255,.65),rgba(60,130,200,.65))}.mobile-action-btn.reload:active,.mobile-action-btn.reload.active{background:linear-gradient(145deg,rgba(130,210,255,.8),rgba(90,160,230,.8));box-shadow:0 2px 20px rgba(100,180,255,.4)}.mobile-action-btn.weapon{background:linear-gradient(145deg,rgba(255,150,50,.65),rgba(200,100,30,.65))}.mobile-action-btn.weapon:active,.mobile-action-btn.weapon.active{background:linear-gradient(145deg,rgba(255,180,100,.8),rgba(230,130,60,.8));box-shadow:0 2px 20px rgba(255,150,50,.4)}.mobile-action-btn.interact{background:linear-gradient(145deg,rgba(80,200,150,.7),rgba(50,150,100,.7))}.mobile-action-btn .btn-icon{font-size:18px;line-height:1}.mobile-action-btn .btn-label{font-size:9px;opacity:.8;margin-top:2px}.mobile-zoom-controls{position:absolute;display:flex;flex-direction:row;gap:8px;pointer-events:auto;opacity:0;animation:fadeIn .4s ease-out forwards;animation-delay:.25s}.mobile-zoom-btn{border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(40,50,60,.75);border:2px solid rgba(150,200,255,.25);color:rgba(200,220,255,.8);font-size:20px;box-shadow:0 3px 12px rgba(0,0,0,.3);transition:all .1s ease-out}.mobile-zoom-btn:active{background:rgba(60,80,100,.85);border-color:rgba(150,200,255,.5);transform:scale(.92)}.mobile-top-bar{position:absolute;top:0;left:0;right:0;height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:linear-gradient(to bottom,rgba(0,0,0,.4),transparent);pointer-events:none;opacity:0;animation:fadeIn .4s ease-out forwards}.mobile-joystick-label{position:absolute;bottom:-24px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(200,220,255,.5);font-weight:600;text-transform:uppercase;letter-spacing:1px;white-space:nowrap}'

function injectStyle() {
  if (document.getElementById('mobile-controls-style')) return
  const s = document.createElement('style')
  s.id = 'mobile-controls-style'
  s.textContent = CSS
  document.head.appendChild(s)
}

function makeJoystick(id, dirs, r) {
  const d = r * 2
  const container = document.createElement('div')
  container.className = 'mobile-joystick-container'
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

function makeButton(id, icon, label, cls, action, size) {
  const btn = document.createElement('div')
  btn.className = `mobile-action-btn ${cls}`
  btn.dataset.action = action || id
  btn.style.cssText = `width:${size}px;height:${size}px;`
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
  container.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden;'

  const { container: moveEl, knob: moveKnob } = makeJoystick('move', '<span class="dir-up">W</span><span class="dir-down">S</span><span class="dir-left">A</span><span class="dir-right">D</span>', r)
  moveEl.style.cssText = `left:${lay.moveLeft}px;bottom:${lay.moveBottom}px;width:${d}px;height:${d}px;`

  const { container: lookEl, knob: lookKnob } = makeJoystick('look', '<span class="dir-up">↑</span><span class="dir-down">↓</span><span class="dir-left">←</span><span class="dir-right">→</span>', r)
  lookEl.style.cssText = `right:${lay.lookRight}px;bottom:${lay.lookBottom}px;width:${d}px;height:${d}px;`

  const btnsEl = document.createElement('div')
  btnsEl.style.cssText = `position:absolute;bottom:${lay.buttonsBottomOffset}px;right:${lay.buttonsRightOffset}px;pointer-events:auto;z-index:9999;`
  const diamond = document.createElement('div')
  diamond.style.cssText = 'display:grid!important;grid-template-columns:repeat(3,auto);grid-template-rows:repeat(3,auto);gap:12px;align-items:center;justify-items:center;'

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
  btnsEl.appendChild(diamond)

  const zr = lay.lookRight + r
  const zoomEl = document.createElement('div')
  zoomEl.className = 'mobile-zoom-controls'
  zoomEl.style.cssText = `bottom:${res.bottomMargin}px;right:${zr}px;transform:translateX(50%);`
  const zs = Math.max(40, bs * 0.8)
  const zoomInBtn = document.createElement('div')
  zoomInBtn.className = 'mobile-zoom-btn'
  zoomInBtn.textContent = '+'
  zoomInBtn.dataset.action = 'zoomIn'
  zoomInBtn.style.cssText = `width:${zs}px;height:${zs}px;`
  const zoomOutBtn = document.createElement('div')
  zoomOutBtn.className = 'mobile-zoom-btn'
  zoomOutBtn.textContent = '−'
  zoomOutBtn.dataset.action = 'zoomOut'
  zoomOutBtn.style.cssText = `width:${zs}px;height:${zs}px;`
  zoomEl.appendChild(zoomInBtn)
  zoomEl.appendChild(zoomOutBtn)

  const topBar = document.createElement('div')
  topBar.className = 'mobile-top-bar'

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
      document.getElementById('look-joystick-base')?.classList.add('look-active')
      lookKnob.classList.add('look-active')
      const rect = lookEl.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    },
    onLookJoystickMove: (lx, ly) => { lookKnob.style.transform = `translate(calc(-50% + ${lx}px),calc(-50% + ${ly}px))` },
    onLookJoystickEnd: () => {
      lookKnob.style.transform = 'translate(-50%,-50%)'
      lookKnob.classList.remove('look-active')
      document.getElementById('look-joystick-base')?.classList.remove('look-active')
    },
    onInteractablesChanged: targets => {
      const has = targets.size > 0
      useBtn.dataset.action = has ? 'interact' : 'reload'
      useBtn.className = `mobile-action-btn ${has ? 'interact' : 'reload'}`
      const lbl = useBtn.querySelector('.btn-label')
      if (lbl) lbl.textContent = has ? 'USE' : 'RELOAD'
    },
    onLayoutUpdate: (l, rsp) => {
      const rd = rsp.joystickRadius, rdd = rd * 2
      moveEl.style.cssText = `left:${l.moveLeft}px;bottom:${l.moveBottom}px;width:${rdd}px;height:${rdd}px;`
      lookEl.style.cssText = `right:${l.lookRight}px;bottom:${l.lookBottom}px;width:${rdd}px;height:${rdd}px;`
      btnsEl.style.bottom = `${l.buttonsBottomOffset}px`
      btnsEl.style.right = `${l.buttonsRightOffset}px`
      const zr2 = l.lookRight + rd
      zoomEl.style.bottom = `${rsp.bottomMargin}px`
      zoomEl.style.right = `${zr2}px`
      zoomEl.style.transform = 'translateX(50%)'
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
