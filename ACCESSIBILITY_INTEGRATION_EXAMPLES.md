# Accessibility Integration Examples

This document shows practical examples of integrating accessibility features into the game.

## 1. Bootstrap Accessibility in App

### In `client/app.js` initialization:

```javascript
// Near the top of the initialization section
import { createAccessibilityIntegration } from './core/AccessibilityIntegration.js'

// During app setup (after DOM is ready)
async function setupApp() {
  // ... existing setup code ...

  // Initialize accessibility features
  const a11yIntegration = createAccessibilityIntegration({
    fontSizeScale: 100,
    reducedMotion: false,
    containerSelector: 'body'
  })

  // Store for use in game loop and event handlers
  window.__a11yIntegration = a11yIntegration

  // Apply saved settings from previous session
  try {
    const saved = localStorage.getItem('spoint.a11y-settings')
    if (saved) {
      a11yIntegration.applySettings(JSON.parse(saved))
    }
  } catch (e) {
    console.warn('Failed to restore a11y settings:', e?.message)
  }

  // ... rest of setup ...
}
```

## 2. Gamepad Input Integration

### Reading gamepad input in game loop:

```javascript
// In your game's update/render loop
function updateGame(dt) {
  const a11y = window.__a11yIntegration
  if (!a11y) return

  // Update gamepad state
  a11y.update()

  const gamepad = a11y.gamepadController
  if (!gamepad.isConnected()) return

  // Get movement input
  const move = gamepad.getMovement()
  if (move.x !== 0 || move.y !== 0) {
    player.moveDirection(move.x, move.y, dt)
  }

  // Get camera/look input
  const look = gamepad.getLook()
  if (look.x !== 0 || look.y !== 0) {
    camera.rotateBy(look.x, look.y, dt)
  }

  // Check pressed buttons
  if (gamepad.isPressed('jump')) {
    player.jump()
  }
  if (gamepad.isPressed('shoot')) {
    player.shoot()
  }
  if (gamepad.isPressed('interact')) {
    player.interactWithNearby()
  }

  // Get analog trigger values for weapons with variable fire
  const triggers = gamepad.getTriggers()
  if (triggers.right > 0) {
    player.chargeWeapon(triggers.right) // 0-1 charge level
  }
}
```

### Integration with existing InputHandler:

```javascript
// In src/client/InputHandler.js, enhance _getGamepadInput()
// to use the new GamepadController if available

function _getGamepadInputEnhanced() {
  // First try the new GamepadController (if accessibility enabled)
  if (typeof window !== 'undefined' && window.__a11yIntegration) {
    const gamepad = window.__a11yIntegration.gamepadController
    if (gamepad && gamepad.isConnected()) {
      const move = gamepad.getMovement()
      const look = gamepad.getLook()
      const triggers = gamepad.getTriggers()

      return {
        forward: move.y > 0.3,
        backward: move.y < -0.3,
        left: move.x < -0.3,
        right: move.x > 0.3,
        analogForward: move.y,
        analogRight: move.x,
        jump: gamepad.isPressed('jump'),
        sprint: gamepad.isPressed('sprint') || triggers.left > 0.5,
        crouch: gamepad.isPressed('crouch'),
        shoot: gamepad.isPressed('shoot') || triggers.right > 0.5,
        reload: gamepad.isPressed('reload'),
        interact: gamepad.isPressed('interact'),
        yaw: look.x * 2.2, // Camera rotation
        pitch: look.y * 2.2,
        mouseX: 0,
        mouseY: 0,
        isGamepad: true
      }
    }
  }

  // Fallback to original implementation
  return _getGamepadInput()
}
```

## 3. Screen Reader Announcements

### Game events that should announce:

```javascript
// In player controller or game state manager

// When player gains XP
onXpGained(amount) {
  player.xp += amount
  const a11y = window.__a11yIntegration
  if (a11y) {
    a11y.announce(`XP gained: ${amount}`, 'status')
  }
}

// When player levels up
onLevelUp(newLevel) {
  player.level = newLevel
  const a11y = window.__a11yIntegration
  if (a11y) {
    a11y.announce(`Level up! You are now level ${newLevel}`, 'alert')
  }
}

// When inventory changes
onInventoryUpdated(item, quantity) {
  const a11y = window.__a11yIntegration
  if (a11y) {
    if (quantity > 0) {
      a11y.announce(`${item.name} x${quantity} added to inventory`, 'status')
    } else {
      a11y.announce(`${item.name} removed from inventory`, 'status')
    }
  }
}

// When player takes damage
onDamage(amount, source) {
  player.health -= amount
  const a11y = window.__a11yIntegration
  if (a11y) {
    a11y.announce(`Took ${amount} damage from ${source}. Health: ${player.health}`, 'alert')
  }
}

// When critical event happens
onBossFight() {
  const a11y = window.__a11yIntegration
  if (a11y) {
    a11y.announce('Boss fight started! Prepare for battle!', 'alert')
  }
}
```

## 4. Colorblind Mode Application

### Ensure game markers are colorblind-safe:

```javascript
// In UI code for waypoints, markers, etc.

function createWaypoint(position, type) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(1),
    new THREE.MeshBasicMaterial()
  )

  // Use shape AND color for differentiation
  const colors = {
    checkpoint: 0x00ff00, // Green
    enemy: 0xff0000,      // Red
    treasure: 0xffff00,   // Yellow
    npc: 0x0000ff         // Blue
  }

  const shapes = {
    checkpoint: 'sphere',
    enemy: 'cube',
    treasure: 'star',
    npc: 'cylinder'
  }

  marker.material.color.setHex(colors[type] || 0xffffff)
  // Apply shape-based differentiation for colorblind users
  marker.geometry = createGeometry(shapes[type])

  return marker
}

// In UI elements
function createStatusIndicator(status) {
  const indicator = document.createElement('div')
  indicator.className = 'status-indicator'

  // Use both color and icon for differentiation
  const indicators = {
    online: { color: '#00ff00', icon: '●', label: 'Online' },
    away: { color: '#ffff00', icon: '◐', label: 'Away' },
    offline: { color: '#ff0000', icon: '○', label: 'Offline' }
  }

  const config = indicators[status] || indicators.offline
  indicator.style.color = config.color
  indicator.textContent = config.icon
  indicator.setAttribute('aria-label', config.label)
  indicator.title = config.label // Hover text

  return indicator
}
```

## 5. Keyboard Navigation in Custom UI

### Making custom UI components keyboard accessible:

```javascript
// In a custom menu component
function createCustomMenu(items) {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'Main Menu')

  for (const item of items) {
    const button = document.createElement('button')
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-label', item.label)
    button.textContent = item.label
    button.addEventListener('click', item.onClick)
    menu.appendChild(button)
  }

  // Implement arrow key navigation
  let focusedIndex = 0
  menu.addEventListener('keydown', e => {
    const buttons = menu.querySelectorAll('[role="menuitem"]')
    if (e.key === 'ArrowDown') {
      focusedIndex = (focusedIndex + 1) % buttons.length
      buttons[focusedIndex].focus()
    } else if (e.key === 'ArrowUp') {
      focusedIndex = (focusedIndex - 1 + buttons.length) % buttons.length
      buttons[focusedIndex].focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      buttons[focusedIndex].click()
    }
  })

  return menu
}
```

## 6. Font Scaling in UI

### Ensure UI scales properly:

```css
/* In stylesheets, use relative units */
.ui-panel {
  font-size: 1rem;    /* Scales with page font-size */
  padding: 1rem;      /* Padding scales too */
  min-width: 20rem;   /* Width scales */
}

.button {
  font-size: 1em;     /* em inherits from parent */
  padding: 0.5em 1em;
  min-height: 2.75em; /* Ensures 44px at 16px base */
}

.heading {
  font-size: 1.5rem;  /* 1.5x the page font-size */
  line-height: 1.3;   /* Maintain readability */
}

/* Test at extreme scales */
@media (font-size-scale: 80%) {
  /* Verify no cutoff */
}

@media (font-size-scale: 120%) {
  /* Verify no horizontal scroll */
}
```

## 7. ARIA Labels in Dynamic Content

### Add ARIA labels when creating UI elements dynamically:

```javascript
// In chat or message system
function createChatMessage(author, content, timestamp) {
  const msg = document.createElement('div')
  msg.className = 'chat-message'

  const authorEl = document.createElement('span')
  authorEl.className = 'author'
  authorEl.textContent = author

  const contentEl = document.createElement('span')
  contentEl.className = 'content'
  contentEl.textContent = content

  const timeEl = document.createElement('span')
  timeEl.className = 'timestamp'
  timeEl.textContent = new Date(timestamp).toLocaleTimeString()

  // Add ARIA labels for context
  msg.setAttribute('aria-label', `Message from ${author} at ${new Date(timestamp).toLocaleTimeString()}: ${content}`)
  msg.appendChild(authorEl)
  msg.appendChild(contentEl)
  msg.appendChild(timeEl)

  return msg
}

// In notifications
function showNotification(message, type = 'info') {
  const notification = document.createElement('div')
  notification.className = `notification notification-${type}`
  notification.textContent = message

  // Screen reader will announce immediately (assertive live region)
  notification.setAttribute('role', 'alert')
  notification.setAttribute('aria-live', 'assertive')

  document.body.appendChild(notification)

  // Auto-dismiss
  setTimeout(() => notification.remove(), 5000)
}
```

## 8. Touch Target Verification

### Before shipping, verify all targets:

```javascript
// In test/verification code
function auditAccessibility() {
  const a11y = window.__a11yIntegration
  if (!a11y) {
    console.error('Accessibility system not initialized')
    return
  }

  console.log('=== Accessibility Audit ===')

  // Check touch targets
  const touchIssues = a11y.a11y.verifyTouchTargets()
  if (touchIssues.length > 0) {
    console.warn('Touch target issues found:')
    for (const issue of touchIssues) {
      console.warn(`  - ${issue.label}: ${issue.width}x${issue.height}px (min 44x44)`)
    }
  } else {
    console.log('✓ All touch targets ≥44x44px')
  }

  // Check color contrast on key elements
  const elements = document.querySelectorAll('[data-a11y-verify-contrast]')
  for (const el of elements) {
    const contrast = a11y.a11y.verifyContrast(el)
    if (!contrast.meetsAA) {
      console.warn(`Low contrast on "${el.textContent}": ${contrast.contrast}:1 (need ≥4.5:1)`)
    } else {
      console.log(`✓ "${el.textContent}": ${contrast.contrast}:1 (AA)`)
    }
  }

  // Check gamepad detection
  if (a11y.gamepadController.isConnected()) {
    console.log('✓ Gamepad connected:', a11y.gamepadController.getConnectedGamepads())
  } else {
    console.log('✓ Gamepad support available (no controllers connected)')
  }

  // Check colorblind modes
  const modes = a11y.colorblindFilter.getAvailableModes()
  console.log(`✓ Colorblind modes available: ${modes.map(m => m.name).join(', ')}`)

  // Check font scaling
  console.log(`✓ Font scale: ${a11y.a11y.fontSizeScale}%`)
  console.log(`✓ Reduced motion: ${a11y.a11y.reducedMotion ? 'enabled' : 'disabled'}`)

  console.log('=== Audit Complete ===')
}

// Run on page load or in console
auditAccessibility()
```

## 9. Testing Accessibility Features

### In a test harness or dev console:

```javascript
// Test gamepad input
function testGamepad() {
  const gpad = window.__a11yIntegration?.gamepadController
  if (!gpad) console.error('Accessibility not initialized')

  console.log('Testing gamepad...')
  gpad.update()
  console.log('Movement:', gpad.getMovement())
  console.log('Look:', gpad.getLook())
  console.log('Actions:', gpad.getPressedActions())
  console.log('Connected:', gpad.isConnected())
}

// Test colorblind filters
function testColorblindModes() {
  const filter = window.__a11yIntegration?.colorblindFilter
  if (!filter) console.error('Accessibility not initialized')

  const modes = filter.getAvailableModes()
  for (const mode of modes) {
    console.log(`Setting colorblind mode to: ${mode.name}`)
    filter.setMode(mode.id)
    // Player would verify visually here
  }
}

// Test screen reader announcements
function testAnnouncements() {
  const a11y = window.__a11yIntegration
  if (!a11y) console.error('Accessibility not initialized')

  a11y.announce('Testing status announcement', 'status')
  setTimeout(() => a11y.announce('Testing alert announcement', 'alert'), 500)
  setTimeout(() => a11y.announce('Progress update 25%', 'progress'), 1000)
}

// Test font scaling
function testFontScaling() {
  const a11y = window.__a11yIntegration
  if (!a11y) console.error('Accessibility not initialized')

  for (let scale of [80, 90, 100, 110, 120]) {
    console.log(`Setting font scale to ${scale}%`)
    a11y.a11y.setFontScale(scale)
    // Player would verify readability/layout here
  }
}
```

## 10. Persisting Settings

### Save and restore accessibility preferences:

```javascript
// In app shutdown/before reload
function saveAccessibilitySettings() {
  const a11y = window.__a11yIntegration
  if (!a11y) return

  const settings = a11y.getSettings()
  try {
    localStorage.setItem('spoint.a11y-settings', JSON.stringify(settings))
    console.log('Accessibility settings saved:', settings)
  } catch (e) {
    console.error('Failed to save accessibility settings:', e?.message)
  }
}

// On page load (in app initialization)
function restoreAccessibilitySettings() {
  const a11y = window.__a11yIntegration
  if (!a11y) return

  try {
    const saved = localStorage.getItem('spoint.a11y-settings')
    if (saved) {
      const settings = JSON.parse(saved)
      a11y.applySettings(settings)
      console.log('Accessibility settings restored:', settings)
    }
  } catch (e) {
    console.error('Failed to restore accessibility settings:', e?.message)
  }
}

// Bind to page unload (optional)
window.addEventListener('beforeunload', saveAccessibilitySettings)
```

## 11. Mobile Touch Accessibility

### Ensure mobile works well:

```javascript
// Ensure buttons are 44x44px minimum
function createMobileButton(label, onClick) {
  const button = document.createElement('button')
  button.className = 'mobile-button'
  button.textContent = label
  button.setAttribute('aria-label', label)
  button.addEventListener('click', onClick)

  // CSS: .mobile-button { min-height: 44px; min-width: 44px; }
  return button
}

// Ensure spacing between touch targets
const TOUCH_TARGET_MIN = 44 // pixels
const TOUCH_SPACING_MIN = 8  // pixels between targets

// In responsive design, use viewport meta tag
// <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

These examples show how to integrate accessibility features throughout your game. For more details, see `ACCESSIBILITY.md` and `ACCESSIBILITY_CHECKLIST.md`.
