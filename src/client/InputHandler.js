export class InputHandler {
  constructor(config = {}) {
    this.keys = new Map()
    this.mouseX = 0
    this.mouseY = 0
    this.mouseDown = false
    this.callbacks = []
    this.enabled = true

    if (config.enableKeyboard !== false) {
      this.setupKeyboardListeners()
    }

    if (config.enableMouse !== false) {
      this.setupMouseListeners()
    }
  }

  setupKeyboardListeners() {
    if (typeof window === 'undefined') return

    window.addEventListener('keydown', (e) => {
      this.keys.set(e.key.toLowerCase(), true)
    })

    window.addEventListener('keyup', (e) => {
      this.keys.set(e.key.toLowerCase(), false)
    })
  }

  setupMouseListeners() {
    if (typeof window === 'undefined') return

    document.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX
      this.mouseY = e.clientY
    })

    document.addEventListener('mousedown', (e) => {
      this.mouseDown = true
    })

    document.addEventListener('mouseup', (e) => {
      this.mouseDown = false
    })
  }

  getInput() {
    if (!this.enabled) {
      return {
        forward: false,
        backward: false,
        left: false,
        right: false,
        jump: false,
        shoot: this.mouseDown,
        mouseX: this.mouseX,
        mouseY: this.mouseY
      }
    }

    return {
      forward: this.keys.get('w') || this.keys.get('arrowup') || false,
      backward: this.keys.get('s') || this.keys.get('arrowdown') || false,
      left: this.keys.get('a') || this.keys.get('arrowleft') || false,
      right: this.keys.get('d') || this.keys.get('arrowright') || false,
      jump: this.keys.get(' ') || false,
      sprint: this.keys.get('shift') || false,
      shoot: this.mouseDown,
      mouseX: this.mouseX,
      mouseY: this.mouseY
    }
  }

  onInput(callback) {
    this.callbacks.push(callback)
  }

  enable() {
    this.enabled = true
  }

  disable() {
    this.enabled = false
  }
}
