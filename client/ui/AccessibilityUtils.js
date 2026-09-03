// AccessibilityUtils.js -- WCAG 2.1 AA compliance utilities
// Provides ARIA labeling, semantic HTML helpers, focus management, live regions, and keyboard navigation

export class AccessibilityManager {
  constructor(options = {}) {
    this.fontSizeScale = options.fontSizeScale ?? 100 // 80-120%
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

  // Detect system preference for reduced motion
  detectReducedMotion() {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  // Detect system preference for high contrast
  detectHighContrast() {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-contrast: more)').matches
  }

  // Inject base accessibility CSS
  injectAccessibilityStyles() {
    if (document.getElementById('a11y-base-styles')) return

    const style = document.createElement('style')
    style.id = 'a11y-base-styles'
    style.textContent = `
/* Focus indicators: 2px outline on all interactive elements */
button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"] {
  outline-offset: 2px;
}

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible,
textarea:focus-visible, [role="button"]:focus-visible, [role="link"]:focus-visible,
[role="menuitem"]:focus-visible, [role="tab"]:focus-visible {
  outline: 2px solid var(--focus-color, #00d2ff);
}

/* Touch target sizing: minimum 44x44px */
button, a[role="button"], input[type="checkbox"], input[type="radio"],
[role="button"], [role="link"], [role="menuitem"], [role="tab"] {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Font size scaling class */
.font-scale-80 { font-size: 80%; }
.font-scale-90 { font-size: 90%; }
.font-scale-100 { font-size: 100%; }
.font-scale-110 { font-size: 110%; }
.font-scale-120 { font-size: 120%; }

/* Reduced motion: disable animations when prefers-reduced-motion is set */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* High contrast mode: boost text contrast */
@media (prefers-contrast: more) {
  :root {
    --panel-text: #fff;
    --accent: #0088ff;
  }
}

/* Live region announcements */
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

  // Setup live regions for dynamic announcements (XP, level-up, etc.)
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

  // Announce to screen readers via live region
  announce(message, type = 'status') {
    const regionId = type === 'alert' ? 'a11y-alert' : 'a11y-status'
    const region = this.liveRegions.get(regionId)
    if (!region) return

    // Clear then set to ensure screen reader announces it
    region.textContent = ''
    setTimeout(() => {
      region.textContent = message
    }, 100)
  }

  // Setup keyboard navigation Tab order
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
    // Trap focus within active modal/dialog if any
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
        // Shift+Tab
        if (active === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab
        if (active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }

  handleEscapeKey(e) {
    // Close active modal/dialog on Escape
    const activeDialog = document.querySelector('[role="dialog"]:not(.hidden)')
    if (activeDialog) {
      const closeBtn = activeDialog.querySelector('[aria-label="Close"]')
      if (closeBtn) closeBtn.click()
    }
  }

  // Apply font scaling (80-120%)
  setFontScale(scale) {
    if (scale < 80 || scale > 120) {
      console.warn('[AccessibilityManager] Font scale out of range:', scale)
      return false
    }

    this.fontSizeScale = scale

    const root = document.documentElement
    root.style.fontSize = `${scale}%`

    // Save to localStorage
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

  // Apply reduced motion preferences
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

  // Add ARIA label to element
  setAriaLabel(element, label) {
    if (!element) return
    element.setAttribute('aria-label', label)
  }

  // Add ARIA description to element
  setAriaDescription(element, description) {
    if (!element) return
    const descId = `${element.id || 'desc'}-${Math.random().toString(36).slice(2, 9)}`
    const descEl = document.createElement('div')
    descEl.id = descId
    descEl.className = 'sr-only' // screen-reader-only class
    descEl.textContent = description
    element.parentNode?.insertBefore(descEl, element.nextSibling)
    element.setAttribute('aria-describedby', descId)
  }

  // Ensure element is focusable
  makeFocusable(element, ariaRole = null) {
    if (!element) return
    if (!element.hasAttribute('tabindex')) {
      element.setAttribute('tabindex', '0')
    }
    if (ariaRole) {
      element.setAttribute('role', ariaRole)
    }
  }

  // Move focus to element
  focusElement(element) {
    if (!element) return
    try {
      element.focus({ preventScroll: false })
    } catch (e) {
      console.warn('[AccessibilityManager] Focus failed:', e?.message)
    }
  }

  // Verify minimum touch target size
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

  // Verify color contrast (rough check)
  verifyContrast(element) {
    const style = window.getComputedStyle(element)
    const bg = style.backgroundColor
    const fg = style.color

    // Simple luminance calculation (not WCAG spec but useful for detection)
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
      meetsAA: contrast >= 4.5, // WCAG AA level
      meetsAAA: contrast >= 7 // WCAG AAA level
    }
  }

  destroy() {
    this.liveRegions.clear()
  }
}

// Factory function
export function createAccessibilityManager(options = {}) {
  return new AccessibilityManager(options)
}

// Helper: Make element keyboard accessible
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

// Helper: Ensure semantic HTML
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

// Helper: Create accessible link
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
