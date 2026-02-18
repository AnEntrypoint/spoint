import * as THREE from 'three'

const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
const isMobile = typeof window !== 'undefined' && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)

export class MobileControls {
  constructor(options = {}) {
    this.enabled = isTouch || options.forceEnable
    this.options = {
      joystickRadius: 55,
      joystickPosition: { x: 70, y: -100 },
      lookJoystickPosition: { x: -70, y: -100 },
      lookJoystickRadius: 55,
      buttonSize: 52,
      buttonSpacing: 64,
      deadzone: 0.12,
      movementDeadzone: 0.15,
      rotationSensitivity: 0.003,
      zoomSensitivity: 0.008,
      autoShow: true,
      ...options
    }

    this.state = {
      move: { x: 0, y: 0 },
      look: { x: 0, y: 0 },
      lookDelta: { yaw: 0, pitch: 0 },
      jump: false,
      shoot: false,
      reload: false,
      sprint: false,
      crouch: false,
      zoom: 0,
      zoomLevel: 0,
      weapon: false,
      interact: false,
      menu: false
    }

    this.moveJoystick = {
      active: false,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      touchId: null,
      centerX: 0,
      centerY: 0
    }

    this.lookJoystick = {
      active: false,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      touchId: null,
      centerX: 0,
      centerY: 0,
      lastX: 0,
      lastY: 0
    }

    this.pinch = {
      active: false,
      startDist: 0,
      lastDist: 0,
      touchIds: []
    }

    this.activeButtons = new Map()
    this.initialized = false

    if (this.enabled) {
      this.createUI()
      this.setupListeners()
      this.initialized = true
    }
  }

  createUI() {
    this.container = document.createElement('div')
    this.container.id = 'mobile-controls'
    this.container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 9999;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      overflow: hidden;
    `

    this.createStyle()
    this.createMovementJoystick()
    this.createLookJoystick()
    this.createActionButtons()
    this.createZoomControls()
    this.createTopBar()

    document.body.appendChild(this.container)
    this.updateJoystickPositions()
  }

  createStyle() {
    const style = document.createElement('style')
    style.id = 'mobile-controls-style'
    style.textContent = `
      @keyframes buttonPulse {
        0% { transform: scale(1); }
        50% { transform: scale(0.92); }
        100% { transform: scale(1); }
      }
      @keyframes joyGlow {
        0% { box-shadow: 0 0 15px rgba(100, 200, 255, 0.4), inset 0 0 20px rgba(100, 200, 255, 0.1); }
        100% { box-shadow: 0 0 25px rgba(100, 200, 255, 0.6), inset 0 0 30px rgba(100, 200, 255, 0.2); }
      }
      @keyframes joyGlowLook {
        0% { box-shadow: 0 0 15px rgba(255, 150, 100, 0.4), inset 0 0 20px rgba(255, 150, 100, 0.1); }
        100% { box-shadow: 0 0 25px rgba(255, 150, 100, 0.6), inset 0 0 30px rgba(255, 150, 100, 0.2); }
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: scale(0.9); }
        to { opacity: 1; transform: scale(1); }
      }
      .mobile-joystick-container {
        position: absolute;
        bottom: 0;
        width: 140px;
        height: 140px;
        pointer-events: auto;
        touch-action: none;
        opacity: 0;
        animation: fadeIn 0.4s ease-out forwards;
        animation-delay: 0.1s;
      }
      .mobile-joystick-base {
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: radial-gradient(circle at 30% 30%, rgba(60, 80, 100, 0.5), rgba(20, 30, 40, 0.7));
        border: 2px solid rgba(150, 200, 255, 0.25);
        box-shadow: 
          0 4px 20px rgba(0, 0, 0, 0.4),
          inset 0 2px 10px rgba(255, 255, 255, 0.05);
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .mobile-joystick-base.active {
        border-color: rgba(100, 200, 255, 0.6);
        animation: joyGlow 1.5s ease-in-out infinite;
      }
      .mobile-joystick-base.look-active {
        border-color: rgba(255, 180, 100, 0.6);
        animation: joyGlowLook 1.5s ease-in-out infinite;
      }
      .mobile-joystick-knob {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 35%, rgba(180, 200, 220, 0.6), rgba(100, 130, 160, 0.5));
        border: 2px solid rgba(200, 220, 255, 0.4);
        transform: translate(-50%, -50%);
        box-shadow: 
          0 3px 12px rgba(0, 0, 0, 0.3),
          inset 0 2px 6px rgba(255, 255, 255, 0.2);
        transition: transform 0.05s ease-out, background 0.1s;
      }
      .mobile-joystick-knob.active {
        background: radial-gradient(circle at 35% 35%, rgba(120, 220, 255, 0.7), rgba(60, 150, 200, 0.6));
        border-color: rgba(150, 220, 255, 0.7);
      }
      .mobile-joystick-knob.look-active {
        background: radial-gradient(circle at 35% 35%, rgba(255, 180, 120, 0.7), rgba(200, 120, 60, 0.6));
        border-color: rgba(255, 200, 150, 0.7);
      }
      .mobile-joystick-directions {
        position: absolute;
        width: 100%;
        height: 100%;
        pointer-events: none;
        opacity: 0.3;
      }
      .mobile-joystick-directions span {
        position: absolute;
        font-size: 10px;
        color: rgba(200, 220, 255, 0.6);
        font-weight: 600;
      }
      .mobile-joystick-directions .dir-up { top: 8px; left: 50%; transform: translateX(-50%); }
      .mobile-joystick-directions .dir-down { bottom: 8px; left: 50%; transform: translateX(-50%); }
      .mobile-joystick-directions .dir-left { left: 8px; top: 50%; transform: translateY(-50%); }
      .mobile-joystick-directions .dir-right { right: 8px; top: 50%; transform: translateY(-50%); }
      
      .mobile-buttons-container {
        position: absolute;
        bottom: 0;
        right: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        padding: 20px;
        pointer-events: auto;
        opacity: 0;
        animation: fadeIn 0.4s ease-out forwards;
        animation-delay: 0.2s;
      }
      .mobile-button-row {
        display: flex;
        gap: 10px;
        align-items: flex-end;
      }
      .mobile-action-btn {
        width: 54px;
        height: 54px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.9);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
        cursor: pointer;
        transition: all 0.08s ease-out;
        border: 2px solid rgba(200, 220, 255, 0.3);
        box-shadow: 
          0 4px 15px rgba(0, 0, 0, 0.35),
          inset 0 1px 3px rgba(255, 255, 255, 0.15);
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
      }
      .mobile-action-btn:active, .mobile-action-btn.active {
        transform: scale(0.92);
        border-color: rgba(255, 255, 255, 0.6);
      }
      .mobile-action-btn.primary {
        background: linear-gradient(145deg, rgba(255, 100, 80, 0.7), rgba(200, 60, 50, 0.7));
        width: 64px;
        height: 64px;
      }
      .mobile-action-btn.primary:active, .mobile-action-btn.primary.active {
        background: linear-gradient(145deg, rgba(255, 130, 100, 0.85), rgba(230, 80, 70, 0.85));
        box-shadow: 0 2px 20px rgba(255, 100, 80, 0.5), inset 0 1px 5px rgba(255, 255, 255, 0.3);
      }
      .mobile-action-btn.jump {
        background: linear-gradient(145deg, rgba(80, 200, 120, 0.65), rgba(50, 150, 80, 0.65));
      }
      .mobile-action-btn.jump:active, .mobile-action-btn.jump.active {
        background: linear-gradient(145deg, rgba(100, 230, 150, 0.8), rgba(70, 180, 100, 0.8));
        box-shadow: 0 2px 20px rgba(80, 200, 120, 0.4);
      }
      .mobile-action-btn.sprint {
        background: linear-gradient(145deg, rgba(255, 200, 60, 0.65), rgba(200, 150, 30, 0.65));
      }
      .mobile-action-btn.sprint:active, .mobile-action-btn.sprint.active {
        background: linear-gradient(145deg, rgba(255, 220, 100, 0.8), rgba(230, 180, 60, 0.8));
        box-shadow: 0 2px 20px rgba(255, 200, 60, 0.4);
      }
      .mobile-action-btn.crouch {
        background: linear-gradient(145deg, rgba(150, 130, 255, 0.65), rgba(100, 80, 200, 0.65));
      }
      .mobile-action-btn.crouch:active, .mobile-action-btn.crouch.active {
        background: linear-gradient(145deg, rgba(180, 160, 255, 0.8), rgba(130, 110, 230, 0.8));
        box-shadow: 0 2px 20px rgba(150, 130, 255, 0.4);
      }
      .mobile-action-btn.reload {
        background: linear-gradient(145deg, rgba(100, 180, 255, 0.65), rgba(60, 130, 200, 0.65));
      }
      .mobile-action-btn.reload:active, .mobile-action-btn.reload.active {
        background: linear-gradient(145deg, rgba(130, 210, 255, 0.8), rgba(90, 160, 230, 0.8));
        box-shadow: 0 2px 20px rgba(100, 180, 255, 0.4);
      }
      .mobile-action-btn.weapon {
        background: linear-gradient(145deg, rgba(255, 150, 50, 0.65), rgba(200, 100, 30, 0.65));
      }
      .mobile-action-btn.weapon:active, .mobile-action-btn.weapon.active {
        background: linear-gradient(145deg, rgba(255, 180, 100, 0.8), rgba(230, 130, 60, 0.8));
        box-shadow: 0 2px 20px rgba(255, 150, 50, 0.4);
      }
      .mobile-action-btn .btn-icon {
        font-size: 18px;
        line-height: 1;
      }
      .mobile-action-btn .btn-label {
        font-size: 9px;
        opacity: 0.8;
        margin-top: 2px;
      }
      .mobile-action-btn.large {
        width: 64px;
        height: 64px;
      }
      .mobile-action-btn.large .btn-icon {
        font-size: 24px;
      }
      
      .mobile-zoom-controls {
        position: absolute;
        right: 90px;
        bottom: 140px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: auto;
        opacity: 0;
        animation: fadeIn 0.4s ease-out forwards;
        animation-delay: 0.25s;
      }
      .mobile-zoom-btn {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(40, 50, 60, 0.75);
        border: 2px solid rgba(150, 200, 255, 0.25);
        color: rgba(200, 220, 255, 0.8);
        font-size: 20px;
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.3);
        transition: all 0.1s ease-out;
      }
      .mobile-zoom-btn:active {
        background: rgba(60, 80, 100, 0.85);
        border-color: rgba(150, 200, 255, 0.5);
        transform: scale(0.92);
      }
      
      .mobile-top-bar {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        background: linear-gradient(to bottom, rgba(0, 0, 0, 0.4), transparent);
        pointer-events: none;
        opacity: 0;
        animation: fadeIn 0.4s ease-out forwards;
      }
      .mobile-joystick-label {
        position: absolute;
        bottom: -24px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
        color: rgba(200, 220, 255, 0.5);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        white-space: nowrap;
      }
      
      .mobile-interact-btn {
        position: absolute;
        bottom: 200px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 24px;
        border-radius: 24px;
        background: rgba(80, 200, 150, 0.7);
        border: 2px solid rgba(150, 255, 200, 0.4);
        color: white;
        font-size: 13px;
        font-weight: 600;
        pointer-events: auto;
        opacity: 0;
        animation: fadeIn 0.4s ease-out forwards;
        animation-delay: 0.3s;
        box-shadow: 0 4px 20px rgba(80, 200, 150, 0.3);
        transition: all 0.1s ease-out;
      }
      .mobile-interact-btn:active {
        transform: translateX(-50%) scale(0.95);
        background: rgba(100, 220, 170, 0.85);
      }
    `
    document.head.appendChild(style)
  }

  createMovementJoystick() {
    const joyPos = this.options.joystickPosition
    
    this.moveJoystickContainer = document.createElement('div')
    this.moveJoystickContainer.className = 'mobile-joystick-container'
    this.moveJoystickContainer.id = 'move-joystick'
    this.moveJoystickContainer.style.cssText = `
      left: ${joyPos.x}px;
      transform: translateY(${joyPos.y}px);
    `

    const base = document.createElement('div')
    base.className = 'mobile-joystick-base'
    base.id = 'move-joystick-base'
    
    const directions = document.createElement('div')
    directions.className = 'mobile-joystick-directions'
    directions.innerHTML = `
      <span class="dir-up">W</span>
      <span class="dir-down">S</span>
      <span class="dir-left">A</span>
      <span class="dir-right">D</span>
    `
    
    this.moveJoystickKnob = document.createElement('div')
    this.moveJoystickKnob.className = 'mobile-joystick-knob'
    this.moveJoystickKnob.id = 'move-joystick-knob'
    
    const label = document.createElement('div')
    label.className = 'mobile-joystick-label'
    label.textContent = 'MOVE'
    
    base.appendChild(directions)
    this.moveJoystickContainer.appendChild(base)
    this.moveJoystickContainer.appendChild(this.moveJoystickKnob)
    this.moveJoystickContainer.appendChild(label)
    this.container.appendChild(this.moveJoystickContainer)
  }

  createLookJoystick() {
    const joyPos = this.options.lookJoystickPosition
    
    this.lookJoystickContainer = document.createElement('div')
    this.lookJoystickContainer.className = 'mobile-joystick-container'
    this.lookJoystickContainer.id = 'look-joystick'
    this.lookJoystickContainer.style.cssText = `
      right: ${-joyPos.x}px;
      transform: translateY(${joyPos.y}px);
    `

    const base = document.createElement('div')
    base.className = 'mobile-joystick-base'
    base.id = 'look-joystick-base'
    
    const directions = document.createElement('div')
    directions.className = 'mobile-joystick-directions'
    directions.innerHTML = `
      <span class="dir-up">↑</span>
      <span class="dir-down">↓</span>
      <span class="dir-left">←</span>
      <span class="dir-right">→</span>
    `
    
    this.lookJoystickKnob = document.createElement('div')
    this.lookJoystickKnob.className = 'mobile-joystick-knob'
    this.lookJoystickKnob.id = 'look-joystick-knob'
    
    const label = document.createElement('div')
    label.className = 'mobile-joystick-label'
    label.textContent = 'LOOK'
    
    base.appendChild(directions)
    this.lookJoystickContainer.appendChild(base)
    this.lookJoystickContainer.appendChild(this.lookJoystickKnob)
    this.lookJoystickContainer.appendChild(label)
    this.container.appendChild(this.lookJoystickContainer)
  }

  createActionButtons() {
    this.buttonsContainer = document.createElement('div')
    this.buttonsContainer.className = 'mobile-buttons-container'
    
    const primaryRow = document.createElement('div')
    primaryRow.className = 'mobile-button-row'
    
    const shootBtn = this.createActionButton('shoot', '●', 'FIRE', 'primary large')
    primaryRow.appendChild(shootBtn)
    
    const actionRow = document.createElement('div')
    actionRow.className = 'mobile-button-row'
    
    const jumpBtn = this.createActionButton('jump', '▲', 'JUMP', 'jump')
    const crouchBtn = this.createActionButton('crouch', '▼', 'CROUCH', 'crouch')
    const reloadBtn = this.createActionButton('reload', '↻', 'RELOAD', 'reload')
    
    actionRow.appendChild(crouchBtn)
    actionRow.appendChild(jumpBtn)
    actionRow.appendChild(reloadBtn)
    
    const secondaryRow = document.createElement('div')
    secondaryRow.className = 'mobile-button-row'
    
    const sprintBtn = this.createActionButton('sprint', '▶▶', 'SPRINT', 'sprint')
    const weaponBtn = this.createActionButton('weapon', '⚔', 'WEAPON', 'weapon')
    
    secondaryRow.appendChild(sprintBtn)
    secondaryRow.appendChild(weaponBtn)
    
    this.buttonsContainer.appendChild(primaryRow)
    this.buttonsContainer.appendChild(actionRow)
    this.buttonsContainer.appendChild(secondaryRow)
    this.container.appendChild(this.buttonsContainer)
    
    this.interactBtn = document.createElement('div')
    this.interactBtn.className = 'mobile-interact-btn'
    this.interactBtn.textContent = 'INTERACT [E]'
    this.interactBtn.dataset.action = 'interact'
    this.container.appendChild(this.interactBtn)
  }

  createActionButton(id, icon, label, className) {
    const btn = document.createElement('div')
    btn.className = `mobile-action-btn ${className}`
    btn.dataset.action = id
    
    const iconSpan = document.createElement('span')
    iconSpan.className = 'btn-icon'
    iconSpan.textContent = icon
    
    const labelSpan = document.createElement('span')
    labelSpan.className = 'btn-label'
    labelSpan.textContent = label
    
    btn.appendChild(iconSpan)
    btn.appendChild(labelSpan)
    
    this.buttons.set(id, btn)
    return btn
  }

  createZoomControls() {
    this.zoomContainer = document.createElement('div')
    this.zoomContainer.className = 'mobile-zoom-controls'
    
    const zoomInBtn = document.createElement('div')
    zoomInBtn.className = 'mobile-zoom-btn'
    zoomInBtn.textContent = '+'
    zoomInBtn.dataset.action = 'zoomIn'
    
    const zoomOutBtn = document.createElement('div')
    zoomOutBtn.className = 'mobile-zoom-btn'
    zoomOutBtn.textContent = '−'
    zoomOutBtn.dataset.action = 'zoomOut'
    
    this.zoomContainer.appendChild(zoomInBtn)
    this.zoomContainer.appendChild(zoomOutBtn)
    this.container.appendChild(this.zoomContainer)
    
    this.zoomButtons = { zoomIn: zoomInBtn, zoomOut: zoomOutBtn }
  }

  createTopBar() {
    this.topBar = document.createElement('div')
    this.topBar.className = 'mobile-top-bar'
    this.container.appendChild(this.topBar)
  }

  updateJoystickPositions() {
    const screenHeight = window.innerHeight
    const screenWidth = window.innerWidth
    
    const moveBottom = -this.options.joystickPosition.y
    const moveLeft = this.options.joystickPosition.x
    
    const lookBottom = -this.options.lookJoystickPosition.y
    const lookRight = this.options.lookJoystickPosition.x
    
    if (this.moveJoystickContainer) {
      this.moveJoystickContainer.style.left = `${moveLeft}px`
      this.moveJoystickContainer.style.bottom = `${moveBottom}px`
      this.moveJoystickContainer.style.transform = 'none'
    }
    
    if (this.lookJoystickContainer) {
      this.lookJoystickContainer.style.right = `${lookRight}px`
      this.lookJoystickContainer.style.bottom = `${lookBottom}px`
      this.lookJoystickContainer.style.transform = 'none'
    }
    
    this.moveJoystick.centerX = moveLeft + 70
    this.moveJoystick.centerY = screenHeight - moveBottom + 70
    
    this.lookJoystick.centerX = screenWidth - lookRight - 70
    this.lookJoystick.centerY = screenHeight - lookBottom + 70
  }

  setupListeners() {
    document.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false })
    document.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false })
    document.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false })
    document.addEventListener('touchcancel', this.onTouchEnd.bind(this), { passive: false })
    
    window.addEventListener('resize', () => {
      this.updateJoystickPositions()
    })
  }

  isTouchOnMoveJoystick(x, y) {
    const rect = this.moveJoystickContainer.getBoundingClientRect()
    return x >= rect.left - 30 && x <= rect.right + 30 && 
           y >= rect.top - 30 && y <= rect.bottom + 30
  }

  isTouchOnLookJoystick(x, y) {
    const rect = this.lookJoystickContainer.getBoundingClientRect()
    return x >= rect.left - 30 && x <= rect.right + 30 && 
           y >= rect.top - 30 && y <= rect.bottom + 30
  }

  getButtonAtPosition(x, y) {
    const checkButton = (btn) => {
      const rect = btn.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    }
    
    for (const [id, btn] of this.buttons) {
      if (checkButton(btn)) return id
    }
    
    if (this.interactBtn && checkButton(this.interactBtn)) return 'interact'
    if (this.zoomButtons.zoomIn && checkButton(this.zoomButtons.zoomIn)) return 'zoomIn'
    if (this.zoomButtons.zoomOut && checkButton(this.zoomButtons.zoomOut)) return 'zoomOut'
    
    return null
  }

  onTouchStart(e) {
    if (!this.enabled) return

    for (const touch of e.changedTouches) {
      const x = touch.clientX
      const y = touch.clientY

      if (this.isTouchOnMoveJoystick(x, y)) {
        this.moveJoystick.active = true
        this.moveJoystick.touchId = touch.identifier
        this.moveJoystick.startX = x
        this.moveJoystick.startY = y
        this.moveJoystick.currentX = x
        this.moveJoystick.currentY = y
        
        const rect = this.moveJoystickContainer.getBoundingClientRect()
        this.moveJoystick.centerX = rect.left + rect.width / 2
        this.moveJoystick.centerY = rect.top + rect.height / 2
        
        document.getElementById('move-joystick-base')?.classList.add('active')
        this.moveJoystickKnob.classList.add('active')
        e.preventDefault()
        continue
      }

      if (this.isTouchOnLookJoystick(x, y)) {
        this.lookJoystick.active = true
        this.lookJoystick.touchId = touch.identifier
        this.lookJoystick.startX = x
        this.lookJoystick.startY = y
        this.lookJoystick.currentX = x
        this.lookJoystick.currentY = y
        this.lookJoystick.lastX = x
        this.lookJoystick.lastY = y
        
        const rect = this.lookJoystickContainer.getBoundingClientRect()
        this.lookJoystick.centerX = rect.left + rect.width / 2
        this.lookJoystick.centerY = rect.top + rect.height / 2
        
        document.getElementById('look-joystick-base')?.classList.add('look-active')
        this.lookJoystickKnob.classList.add('look-active')
        e.preventDefault()
        continue
      }

      const buttonId = this.getButtonAtPosition(x, y)
      if (buttonId) {
        if (buttonId === 'zoomIn') {
          this.state.zoomLevel = Math.min(this.state.zoomLevel + 1, 3)
        } else if (buttonId === 'zoomOut') {
          this.state.zoomLevel = Math.max(this.state.zoomLevel - 1, 0)
        } else if (buttonId === 'interact') {
          this.state.interact = true
          this.interactBtn.classList.add('active')
        } else {
          this.state[buttonId] = true
          const btn = this.buttons.get(buttonId)
          if (btn) btn.classList.add('active')
        }
        this.activeButtons.set(touch.identifier, buttonId)
        e.preventDefault()
        continue
      }

      if (!this.moveJoystick.active && !this.lookJoystick.active && !this.pinch.active) {
        if (this.lookJoystick.active) {
          this.pinch.active = true
          this.pinch.touchIds = [this.lookJoystick.touchId, touch.identifier]
          this.pinch.startDist = this.getPinchDistance(e.touches)
          this.pinch.lastDist = this.pinch.startDist
          this.lookJoystick.active = false
        } else {
          this.lookJoystick.active = true
          this.lookJoystick.touchId = touch.identifier
          this.lookJoystick.startX = x
          this.lookJoystick.startY = y
          this.lookJoystick.lastX = x
          this.lookJoystick.lastY = y
          this.lookJoystick.centerX = x
          this.lookJoystick.centerY = y
          
          document.getElementById('look-joystick-base')?.classList.add('look-active')
          this.lookJoystickKnob.classList.add('look-active')
        }
      }
    }
  }

  onTouchMove(e) {
    if (!this.enabled) return

    for (const touch of e.changedTouches) {
      const x = touch.clientX
      const y = touch.clientY

      if (this.moveJoystick.active && touch.identifier === this.moveJoystick.touchId) {
        this.moveJoystick.currentX = x
        this.moveJoystick.currentY = y

        let dx = x - this.moveJoystick.centerX
        let dy = y - this.moveJoystick.centerY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const maxDist = this.options.joystickRadius

        if (dist > maxDist) {
          dx = (dx / dist) * maxDist
          dy = (dy / dist) * maxDist
        }

        this.moveJoystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`

        const deadzone = this.options.movementDeadzone
        const normalizedDist = Math.min(dist / maxDist, 1)
        if (normalizedDist < deadzone) {
          this.state.move.x = 0
          this.state.move.y = 0
        } else {
          const scale = (normalizedDist - deadzone) / (1 - deadzone)
          this.state.move.x = (dx / maxDist) * scale
          this.state.move.y = -(dy / maxDist) * scale
        }
        e.preventDefault()
      }

      if (this.lookJoystick.active && touch.identifier === this.lookJoystick.touchId) {
        const dx = x - this.lookJoystick.lastX
        const dy = y - this.lookJoystick.lastY

        this.state.lookDelta.yaw -= dx * this.options.rotationSensitivity
        this.state.lookDelta.pitch -= dy * this.options.rotationSensitivity
        this.state.lookDelta.pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, this.state.lookDelta.pitch))

        let lx = x - this.lookJoystick.centerX
        let ly = y - this.lookJoystick.centerY
        const lookDist = Math.sqrt(lx * lx + ly * ly)
        const lookMaxDist = this.options.lookJoystickRadius

        if (lookDist > lookMaxDist) {
          lx = (lx / lookDist) * lookMaxDist
          ly = (ly / lookDist) * lookMaxDist
        }
        
        this.lookJoystickKnob.style.transform = `translate(calc(-50% + ${lx}px), calc(-50% + ${ly}px))`

        this.lookJoystick.lastX = x
        this.lookJoystick.lastY = y
        e.preventDefault()
      }
    }

    if (this.pinch.active && e.touches.length >= 2) {
      const dist = this.getPinchDistance(e.touches)
      const delta = dist - this.pinch.lastDist
      this.state.zoomLevel = Math.max(0, Math.min(3, this.state.zoomLevel + delta * 0.005))
      this.pinch.lastDist = dist
      e.preventDefault()
    }
  }

  onTouchEnd(e) {
    if (!this.enabled) return

    for (const touch of e.changedTouches) {
      if (this.moveJoystick.active && touch.identifier === this.moveJoystick.touchId) {
        this.moveJoystick.active = false
        this.moveJoystick.touchId = null
        this.state.move.x = 0
        this.state.move.y = 0
        this.moveJoystickKnob.style.transform = 'translate(-50%, -50%)'
        this.moveJoystickKnob.classList.remove('active')
        document.getElementById('move-joystick-base')?.classList.remove('active')
      }

      if (this.lookJoystick.active && touch.identifier === this.lookJoystick.touchId) {
        this.lookJoystick.active = false
        this.lookJoystick.touchId = null
        this.lookJoystickKnob.style.transform = 'translate(-50%, -50%)'
        this.lookJoystickKnob.classList.remove('active')
        document.getElementById('look-joystick-base')?.classList.remove('look-active')
      }

      if (this.pinch.active) {
        const idx = this.pinch.touchIds.indexOf(touch.identifier)
        if (idx !== -1) {
          this.pinch.touchIds.splice(idx, 1)
        }
        if (this.pinch.touchIds.length < 2) {
          this.pinch.active = false
        }
      }

      const activeButton = this.activeButtons.get(touch.identifier)
      if (activeButton) {
        if (activeButton === 'interact') {
          this.state.interact = false
          this.interactBtn.classList.remove('active')
        } else if (activeButton !== 'zoomIn' && activeButton !== 'zoomOut') {
          this.state[activeButton] = false
          const btn = this.buttons.get(activeButton)
          if (btn) btn.classList.remove('active')
        }
        this.activeButtons.delete(touch.identifier)
      }
    }
  }

  getPinchDistance(touches) {
    const touchArray = Array.from(touches)
    if (touchArray.length < 2) return 0
    const dx = touchArray[0].clientX - touchArray[1].clientX
    const dy = touchArray[0].clientY - touchArray[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  getInput() {
    if (!this.enabled) return null

    const move = this.state.move
    const deadzone = 0.3

    return {
      forward: move.y < -deadzone,
      backward: move.y > deadzone,
      left: move.x < -deadzone,
      right: move.x > deadzone,
      jump: this.state.jump,
      shoot: this.state.shoot,
      reload: this.state.reload,
      sprint: this.state.sprint,
      crouch: this.state.crouch,
      yaw: this.state.lookDelta.yaw,
      pitch: this.state.lookDelta.pitch,
      zoom: this.state.zoomLevel,
      moveX: move.x,
      moveY: move.y,
      mouseX: 0,
      mouseY: 0,
      interact: this.state.interact,
      weapon: this.state.weapon,
      analogForward: move.y,
      analogRight: move.x
    }
  }

  hasInteraction() {
    return this.moveJoystick.active || 
           this.lookJoystick.active || 
           this.pinch.active ||
           this.state.jump ||
           this.state.shoot ||
           this.state.reload ||
           this.state.sprint ||
           this.state.crouch ||
           this.state.interact ||
           this.state.weapon
  }

  resetLookDelta() {
    this.state.lookDelta.yaw = 0
    this.state.lookDelta.pitch = 0
  }

  setEnabled(enabled) {
    this.enabled = enabled && (isTouch || this.options.forceEnable)
    if (this.container) {
      this.container.style.display = this.enabled ? 'block' : 'none'
    }
  }

  show() {
    if (this.container) {
      this.container.style.display = 'block'
    }
  }

  hide() {
    if (this.container) {
      this.container.style.display = 'none'
    }
  }

  dispose() {
    if (this.container) {
      this.container.remove()
      this.container = null
    }
    const style = document.getElementById('mobile-controls-style')
    if (style) style.remove()
    
    document.removeEventListener('touchstart', this.onTouchStart)
    document.removeEventListener('touchmove', this.onTouchMove)
    document.removeEventListener('touchend', this.onTouchEnd)
    document.removeEventListener('touchcancel', this.onTouchEnd)
    window.removeEventListener('resize', this.updateJoystickPositions)
  }
}

export function detectDevice() {
  return {
    isTouch,
    isMobile,
    isDesktop: !isMobile && !isTouch,
    hasGamepad: typeof navigator !== 'undefined' && 'getGamepads' in navigator
  }
}
