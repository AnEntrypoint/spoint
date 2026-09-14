export class AccessibilityManager {
  constructor(options = {}) {
    this.fontSizeScale = options.fontSizeScale ?? 100
    this.reducedMotion = options.reducedMotion ?? this.detectReducedMotion()
    this.highContrast = options.highContrast ?? this.detectHighContrast()
    this.liveRegions = new Map()

    this.initialize()
  }

  initialize() {
    this.injectAccessibilityStyles()
    this.setupLiveRegions()
    this.setupKeyboardNavigation()
    this.applyFontScaling()
    this.applyReducedMotion()
  }

  detectReducedMotion() {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  detectHighContrast() {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-contrast: more)').matches
  }

  injectAccessibilityStyles() {
    if (document.getElementById('a11y-base-styles')) return

    const style = document.createElement('style')
    style.id = 'a11y-base-styles'
    style.textContent = `
 
button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"] {
  outline-offset: 2px;
}

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible,
textarea:focus-visible, [role="button"]:focus-visible, [role="link"]:focus-visible,
[role="menuitem"]:focus-visible, [role="tab"]:focus-visible {
  outline: 2px solid var(--focus-color, #00d2ff);
}

 
button, a[role="button"], input[type="checkbox"], input[type="radio"],
[role="button"], [role="link"], [role="menuitem"], [role="tab"] {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

 
.font-scale-80 { font-size: 80%; }
.font-scale-90 { font-size: 90%; }
.font-scale-100 { font-size: 100%; }
.font-scale-110 { font-size: 110%; }
.font-scale-120 { font-size: 120%; }

 
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

 
@media (prefers-contrast: more) {
  :root {
    --panel-text: #fff;
    --accent: #0088ff;
  }
}

 
[aria-live] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

[aria-live].visible {
  position: static;
  width: auto;
  height: auto;
  overflow: visible;
  clip: auto;
}
    `
    document.head.appendChild(style)
  }

  setupLiveRegions() {
    const regions = [
      { id: 'a11y-status', ariaLive: 'polite', ariaAtomic: 'true' },
      { id: 'a11y-alert', ariaLive: 'assertive', ariaAtomic: 'true' },
      { id: 'a11y-progress', ariaLive: 'polite', ariaAtomic: 'false' }
    ]

    for (const region of regions) {
      if (!document.getElementById(region.id)) {
        const el = document.createElement('div')
        el.id = region.id
        el.setAttribute('aria-live', region.ariaLive)
        el.setAttribute('aria-atomic', region.ariaAtomic)
        el.setAttribute('role', 'status')
        document.body.appendChild(el)
        this.liveRegions.set(region.id, el)
      }
    }
  }

  announce(message, type = 'status') {
    const regionId = type === 'alert' ? 'a11y-alert' : 'a11y-status'
    const region = this.liveRegions.get(regionId)
    if (!region) return

    region.textContent = ''
    setTimeout(() => {
      region.textContent = message
    }, 100)
  }

  setupKeyboardNavigation() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        this.handleTabNavigation(e)
      } else if (e.key === 'Escape') {
        this.handleEscapeKey(e)
      }
    })
  }

  handleTabNavigation(e) {
    const activeDialog = document.querySelector('[role="dialog"]:not(.hidden)')
    if (activeDialog) {
      const focusableElements = activeDialog.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusableElements.length === 0) return

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]
      const active = document.activeElement

      if (e.shiftKey) {
        if (active === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }

  handleEscapeKey(e) {
    const activeDialog = document.querySelector('[role="dialog"]:not(.hidden)')
    if (activeDialog) {
      const closeBtn = activeDialog.querySelector('[aria-label="Close"]')
      if (closeBtn) closeBtn.click()
    }
  }

  setFontScale(scale) {
    if (scale < 80 || scale > 120) {
      console.warn('[AccessibilityManager] Font scale out of range:', scale)
      return false
    }

    this.fontSizeScale = scale

    const root = document.documentElement
    root.style.fontSize = `${scale}%`

    try {
      localStorage.setItem('spoint.font-scale', scale.toString())
    } catch (e) {
      console.warn('[AccessibilityManager] localStorage write failed:', e?.message)
    }

    return true
  }

  getFontScale() {
    return this.fontSizeScale
  }

  applyReducedMotion() {
    if (this.reducedMotion) {
      document.documentElement.setAttribute('data-reduced-motion', 'true')
    } else {
      document.documentElement.removeAttribute('data-reduced-motion')
    }
  }

  setReducedMotion(enabled) {
    this.reducedMotion = enabled
    this.applyReducedMotion()
    try {
      localStorage.setItem('spoint.reduced-motion', enabled ? 'true' : 'false')
    } catch (e) {
      console.warn('[AccessibilityManager] localStorage write failed:', e?.message)
    }
  }

  setAriaLabel(element, label) {
    if (!element) return
    element.setAttribute('aria-label', label)
  }

  setAriaDescription(element, description) {
    if (!element) return
    const descId = `${element.id || 'desc'}-${Math.random().toString(36).slice(2, 9)}`
    const descEl = document.createElement('div')
    descEl.id = descId
    descEl.className = 'sr-only'
    descEl.textContent = description
    element.parentNode?.insertBefore(descEl, element.nextSibling)
    element.setAttribute('aria-describedby', descId)
  }

  makeFocusable(element, ariaRole = null) {
    if (!element) return
    if (!element.hasAttribute('tabindex')) {
      element.setAttribute('tabindex', '0')
    }
    if (ariaRole) {
      element.setAttribute('role', ariaRole)
    }
  }

  focusElement(element) {
    if (!element) return
    try {
      element.focus({ preventScroll: false })
    } catch (e) {
      console.warn('[AccessibilityManager] Focus failed:', e?.message)
    }
  }

  verifyTouchTargets(container = document.body) {
    const issues = []
    const interactiveElements = container.querySelectorAll(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="menuitem"]'
    )

    for (const el of interactiveElements) {
      const rect = el.getBoundingClientRect()
      if (rect.width < 44 || rect.height < 44) {
        issues.push({
          element: el,
          width: rect.width,
          height: rect.height,
          label: el.textContent?.slice(0, 50) || el.getAttribute('aria-label')
        })
      }
    }

    return issues
  }

  verifyContrast(element) {
    const style = window.getComputedStyle(element)
    const bg = style.backgroundColor
    const fg = style.color

    const getLuminance = (color) => {
      const rgb = color.match(/\d+/g)
      if (!rgb || rgb.length < 3) return 0.5
      const r = parseInt(rgb[0]) / 255
      const g = parseInt(rgb[1]) / 255
      const b = parseInt(rgb[2]) / 255
      return 0.299 * r + 0.587 * g + 0.114 * b
    }

    const bgL = getLuminance(bg)
    const fgL = getLuminance(fg)
    const contrast = (Math.max(bgL, fgL) + 0.05) / (Math.min(bgL, fgL) + 0.05)

    return {
      contrast: contrast.toFixed(2),
      meetsAA: contrast >= 4.5,
      meetsAAA: contrast >= 7
    }
  }

  destroy() {
    this.liveRegions.clear()
  }
}

export function createAccessibilityManager(options = {}) {
  return new AccessibilityManager(options)
}

export function makeKeyboardAccessible(element, clickHandler = null) {
  element.setAttribute('role', 'button')
  element.setAttribute('tabindex', '0')

  element.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (clickHandler) clickHandler()
      else element.click()
    }
  })
}

export function createAccessibleButton(label, onClick, options = {}) {
  const button = document.createElement('button')
  button.textContent = label
  button.setAttribute('aria-label', options.ariaLabel || label)
  if (options.ariaDescription) {
    button.setAttribute('aria-describedby', options.ariaDescription)
  }
  button.addEventListener('click', onClick)
  return button
}

export function createAccessibleLink(label, href, options = {}) {
  const link = document.createElement('a')
  link.href = href
  link.textContent = label
  link.setAttribute('aria-label', options.ariaLabel || label)
  if (options.ariaDescription) {
    link.setAttribute('aria-describedby', options.ariaDescription)
  }
  return link
}
