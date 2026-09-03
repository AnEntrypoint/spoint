// ColorblindFilter.js -- CSS filter-based colorblind modes for WCAG 2.1 AA compliance
// Supports 4 modes: normal, deuteranopia (red-blind), protanopia (green-blind), tritanopia (blue-yellow-blind)
// Applied via CSS filters with no shader cost, persisted to localStorage, toggleable from settings menu

const STORAGE_KEY = 'spoint.colorblind-mode'

// CSS filter definitions for each colorblind mode
// These use well-researched color-space transforms to simulate vision deficiencies
const COLORBLIND_FILTERS = {
  normal: {
    name: 'Normal',
    description: 'Standard color vision',
    filter: 'none'
  },
  deuteranopia: {
    name: 'Deuteranopia',
    description: 'Red-blind (low red sensitivity)',
    // Simulates red-blind vision by shifting red/green perception
    filter: 'url(#deuteranopia-filter)'
  },
  protanopia: {
    name: 'Protanopia',
    description: 'Green-blind (no red cone function)',
    // Simulates green-blind vision
    filter: 'url(#protanopia-filter)'
  },
  tritanopia: {
    name: 'Tritanopia',
    description: 'Blue-yellow-blind (no blue cone function)',
    // Simulates blue-yellow-blind vision
    filter: 'url(#tritanopia-filter)'
  }
}

let filterSvgInjected = false

// Inject SVG filter definitions into the document once
function injectSVGFilters() {
  if (filterSvgInjected) return
  filterSvgInjected = true

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('style', 'display: none; width: 0; height: 0;')
  svg.innerHTML = `
    <defs>
      <!-- Deuteranopia (Red-blind) -->
      <filter id="deuteranopia-filter">
        <feColorMatrix type="matrix" values="
          0.625 0.375 0.000 0 0
          0.700 0.300 0.000 0 0
          0.000 0.300 0.700 0 0
          0.000 0.000 0.000 1 0
        "/>
      </filter>

      <!-- Protanopia (Green-blind) -->
      <filter id="protanopia-filter">
        <feColorMatrix type="matrix" values="
          0.567 0.433 0.000 0 0
          0.558 0.442 0.000 0 0
          0.000 0.242 0.758 0 0
          0.000 0.000 0.000 1 0
        "/>
      </filter>

      <!-- Tritanopia (Blue-yellow-blind) -->
      <filter id="tritanopia-filter">
        <feColorMatrix type="matrix" values="
          0.950 0.050 0.000 0 0
          0.000 0.433 0.567 0 0
          0.000 0.475 0.525 0 0
          0.000 0.000 0.000 1 0
        "/>
      </filter>
    </defs>
  `
  document.body.appendChild(svg)
}

export class ColorblindFilter {
  constructor(options = {}) {
    this.containerSelector = options.containerSelector || 'body'
    this.container = null
    this.currentMode = 'normal'
    this.availableModes = Object.keys(COLORBLIND_FILTERS)

    this.initialize()
  }

  initialize() {
    this.container = document.querySelector(this.containerSelector)
    if (!this.container) {
      console.warn('[ColorblindFilter] Container not found:', this.containerSelector)
      return
    }

    injectSVGFilters()

    // Load persisted mode
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && this.availableModes.includes(saved)) {
      this.setMode(saved)
    }
  }

  // Set the current colorblind filter mode
  setMode(mode) {
    if (!this.availableModes.includes(mode)) {
      console.warn('[ColorblindFilter] Unknown mode:', mode)
      return false
    }

    if (this.currentMode === mode) return true

    const filterDef = COLORBLIND_FILTERS[mode]
    if (!this.container) {
      console.warn('[ColorblindFilter] Container not initialized')
      return false
    }

    try {
      this.container.style.filter = filterDef.filter

      // Persist to localStorage
      try {
        localStorage.setItem(STORAGE_KEY, mode)
      } catch (e) {
        console.warn('[ColorblindFilter] localStorage write failed:', e?.message)
      }

      this.currentMode = mode
      return true
    } catch (e) {
      console.error('[ColorblindFilter] Failed to apply filter:', e)
      return false
    }
  }

  // Get current mode
  getCurrentMode() {
    return this.currentMode
  }

  // Get mode info
  getModeInfo(mode) {
    return COLORBLIND_FILTERS[mode] || null
  }

  // Get all available modes with descriptions
  getAvailableModes() {
    return Object.entries(COLORBLIND_FILTERS).map(([key, val]) => ({
      id: key,
      name: val.name,
      description: val.description,
      active: this.currentMode === key
    }))
  }

  // Apply filter to a specific element (for targeted filtering)
  applyToElement(element, mode = this.currentMode) {
    if (!this.availableModes.includes(mode)) return false

    const filterDef = COLORBLIND_FILTERS[mode]
    try {
      element.style.filter = filterDef.filter
      return true
    } catch (e) {
      console.error('[ColorblindFilter] Failed to apply filter to element:', e)
      return false
    }
  }

  destroy() {
    if (this.container) {
      this.container.style.filter = 'none'
    }
  }
}

// Factory function for convenience
export function createColorblindFilter(options = {}) {
  return new ColorblindFilter(options)
}

// Export filter definitions for external use
export function getColorblindFilters() {
  return { ...COLORBLIND_FILTERS }
}
