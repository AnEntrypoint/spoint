// Tutorial orchestrator: walks a new player through core mechanics (WASD, sprint, jump, interact)
// using checkpoint-marker entities for progression gates and HUD text overlays for instruction prompts.
// Collects placed checkpoint-marker entities (sorted by order) at first update tick, feeds each step's
// prompt to the player via ctx.players.send(), and advances when the player reaches the next marker.
// The final step is an interactable button — the tutorial listens for 'tutorial.finish' on the bus.
import { collectCheckpointMarkers } from '../checkpoint-marker/index.js'

const STEPS = [
  {
    id: 'wasd',
    title: 'Movement',
    text: 'Use WASD keys to move around.\nWalk into the blue marker ahead.',
    hint: 'W=forward A=left S=back D=right',
  },
  {
    id: 'sprint',
    title: 'Sprinting',
    text: 'Hold SHIFT while moving to sprint.\nRun to the next marker.',
    hint: 'SHIFT + W = sprint',
  },
  {
    id: 'jump',
    title: 'Jumping',
    text: 'Press SPACE to jump.\nJump to reach the next marker.',
    hint: 'SPACE = jump',
  },
  {
    id: 'interact',
    title: 'Interacting',
    text: 'Walk up to the button and press E to interact.\nThis completes the tutorial!',
    hint: 'E = interact',
  },
]

function makeOverlay() {
  if (typeof document === 'undefined') return null
  let root = document.getElementById('tutorial-hud')
  if (root) return root
  root = document.createElement('div')
  root.id = 'tutorial-hud'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:100;font-family:system-ui,sans-serif'
  root.innerHTML =
    '<div id="tut-title" style="position:absolute;left:50%;top:10%;transform:translateX(-50%);color:#ffcc00;font-weight:800;font-size:32px;letter-spacing:1px;text-shadow:0 2px 8px #000;text-align:center;transition:opacity .3s">TUTORIAL</div>' +
    '<div id="tut-text" style="position:absolute;left:50%;top:calc(10% + 48px);transform:translateX(-50%);color:#fff;font-size:20px;text-shadow:0 2px 6px #000;text-align:center;max-width:500px;white-space:pre-line;transition:opacity .3s"></div>' +
    '<div id="tut-hint" style="position:absolute;left:50%;bottom:15%;transform:translateX(-50%);color:rgba(255,255,255,.55);font-size:14px;text-shadow:0 1px 4px #000;text-align:center;transition:opacity .3s"></div>'
  document.body.appendChild(root)
  return root
}

export default {
  description: 'Guided tutorial: teaches WASD movement, sprint, jump, and interact (E key) through a sequence of checkpoint markers + HUD prompts.',
  server: {
    async setup(ctx) {
      ctx.state.step = 0
      ctx.state.finished = false
      ctx.state._markers = null           // built on first update tick (see deathrun's _buildCourse comment)
      ctx.state._stepReached = new Set()  // playerIds that have reached the current step
      ctx.state._courseBuilt = false

      // Listen for the button's 'tutorial.finish' event as the final step.
      ctx.bus?.on('tutorial.finish', () => {
        if (ctx.state.finished) return
        ctx.state.finished = true
        for (const player of ctx.players.getAll()) {
          ctx.players.send(player.id, {
            type: 'tutorial_step',
            step: 'interact',
            title: 'Complete!',
            text: 'Tutorial complete! You now know the basics.\nExplore the world or join a game.',
            hint: '',
            finished: true,
          })
        }
      })
    },
    update(ctx, dt) {
      if (!ctx.state._courseBuilt) {
        ctx.state._courseBuilt = true
        _buildCourse(ctx)
      }
      if (ctx.state.finished) return
      _tickProgression(ctx)
    },
    onMessage(ctx, msg) {
      if (!msg) return
      if (msg.type === 'player_join') {
        // Send the current step prompt to the joining player.
        const step = STEPS[ctx.state.step]
        if (step) {
          ctx.players.send(msg.playerId, {
            type: 'tutorial_step',
            step: step.id,
            title: step.title,
            text: step.text,
            hint: step.hint,
            finished: false,
          })
        }
      }
    },
  },

  client: {
    setup(engine) {
      engine._tutorial = { overlay: makeOverlay() }
      const ov = engine._tutorial.overlay
      engine._tutorial._elTitle = ov?.querySelector('#tut-title') || null
      engine._tutorial._elText = ov?.querySelector('#tut-text') || null
      engine._tutorial._elHint = ov?.querySelector('#tut-hint') || null
    },
    onEvent(payload, engine) {
      const tut = engine._tutorial; if (!tut) return
      if (payload.type === 'tutorial_step') {
        if (tut._elTitle) tut._elTitle.textContent = payload.title || ''
        if (tut._elText) tut._elText.textContent = payload.text || ''
        if (tut._elHint) tut._elHint.textContent = payload.hint || ''
      }
    },
  },
}

function _buildCourse(ctx) {
  const markers = collectCheckpointMarkers(ctx)
  if (markers.length === 0) {
    console.warn('[tutorial] no checkpoint-marker entities found — tutorial cannot progress')
    return
  }
  ctx.state._markers = markers

  // Send the first step prompt to all connected players.
  const step = STEPS[0]
  if (step) {
    for (const player of ctx.players.getAll()) {
      ctx.players.send(player.id, {
        type: 'tutorial_step',
        step: step.id,
        title: step.title,
        text: step.text,
        hint: step.hint,
        finished: false,
      })
    }
  }
}

function _tickProgression(ctx) {
  const markers = ctx.state._markers
  if (!markers) return
  const currentStep = ctx.state.step
  if (currentStep >= markers.length) return

  const target = markers[currentStep]
  const r2 = (target.radius ?? 3) ** 2

  for (const player of ctx.players.getAll()) {
    if (ctx.state._stepReached.has(player.id)) continue
    const pp = player.state?.position; if (!pp) continue
    const dx = pp[0] - target.position[0], dy = pp[1] - target.position[1], dz = pp[2] - target.position[2]
    if (dx * dx + dy * dy + dz * dz <= r2) {
      ctx.state._stepReached.add(player.id)
      ctx.state.step = currentStep + 1
      const next = STEPS[currentStep + 1]
      if (next) {
        ctx.players.send(player.id, {
          type: 'tutorial_step',
          step: next.id,
          title: next.title,
          text: next.text,
          hint: next.hint,
          finished: false,
        })
      }
      // Reset the reached set so the next checkpoint can be triggered by the same player.
      ctx.state._stepReached = new Set()
    }
  }
}