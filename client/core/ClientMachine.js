// Dual import: same machine definition unit-testable under node and runnable in browser.
const _isNode = typeof process !== 'undefined' && process.versions?.node
const { createMachine, createActor, assign } = await import(_isNode ? 'xstate' : '/node_modules/xstate/dist/xstate.esm.js')

export const clientMachine = createMachine({
  id: 'client',
  initial: 'loading',
  // editMode is derived from the mode region, not stored here, so it cannot desync.
  context: { snapSize: 0.25, headBoneHidden: false },
  on: {
    SNAP: { actions: assign({ snapSize: ({ event }) => (event && event.size != null) ? event.size : 0.25 }) },
    SET_CAMERA_MODE: { actions: assign({ headBoneHidden: ({ event }) => !!(event && event.inHead) }) }
  },
  states: {
    loading: {
      on: {
        ASSETS_READY: 'ready',
        TOGGLE_EDITOR: { target: 'ready.mode.editor' },
        OPEN_LOBBY: { target: 'ready.mode.lobby' }
      }
    },
    ready: {
      type: 'parallel',
      states: {
        // -- Top-level mode: exactly one of playing / editor / lobby / spectator --
        mode: {
          initial: 'playing',
          states: {
            playing: {
              on: {
                TOGGLE_EDITOR: 'editor',
                OPEN_LOBBY: 'lobby',
                ENTER_SPECTATOR: 'spectator'
              }
            },
            editor: {
              on: {
                TOGGLE_EDITOR: 'playing',
                EXIT_EDITOR: 'playing',
                PLAYTEST: 'playtesting'
              }
            },
            // In-editor play mode: snapshot world state on enter, restore on exit.
            // The editor UI stays visible (panels, toolbar) but the camera switches to
            // follow-cam and gameplay input is enabled. PLAYTEST_STOP rolls back to editor.
            playtesting: {
              on: {
                PLAYTEST_STOP: 'editor',
                EXIT_EDITOR: 'playing'
              }
            },
            lobby: {
              on: {
                CLOSE_LOBBY: 'playing',
                OPEN_LOBBY: 'playing'
              }
            },
            // Spectator: free-fly or player-follow camera, no local player control -- casting/
            // moderation/debugging. Sibling to playing/editor/lobby (never nested under playing),
            // so entering it composes cleanly with the OTHER parallel regions (gizmo/select/snap/
            // docks) exactly like editor/lobby already do -- those regions' own EXIT_EDITOR/
            // TOGGLE_EDITOR reset-on-exit transitions are untouched, spectator does not touch them.
            spectator: {
              initial: 'free',
              on: { EXIT_SPECTATOR: 'playing' },
              states: {
                // Free-fly: reuses cam.js's existing editMode fly-camera (unbound, no physics-body
                // tie) -- see spectatorMode.js, which drives cam.setEditMode(true) while here.
                free: { on: { SPECTATE_FOLLOW: 'follow' } },
                // Follow/chase: camera tracks a chosen connected player's live position/rotation.
                follow: { on: { SPECTATE_FREE: 'free' } }
              }
            }
          }
        },

        gizmo: {
          initial: 'translate',
          states: {
            translate: { on: { ROTATE: 'rotate', SCALE: 'scale', DRAG: 'translateDrag' } },
            translateDrag: { on: { DROP: 'translate' } },
            rotate: { on: { TRANSLATE: 'translate', SCALE: 'scale', DRAG: 'rotateDrag' } },
            rotateDrag: { on: { DROP: 'rotate' } },
            scale: { on: { TRANSLATE: 'translate', ROTATE: 'rotate', DRAG: 'scaleDrag' } },
            scaleDrag: { on: { DROP: 'scale' } }
          },
          on: { EXIT_EDITOR: '.translate', TOGGLE_EDITOR: '.translate' }
        },

        select: {
          initial: 'none',
          states: {
            none: { on: { SELECT: 'selected' } },
            selected: { on: { SELECT: 'selected', DESELECT: 'none' } }
          },
          on: { EXIT_EDITOR: '.none', TOGGLE_EDITOR: '.none' }
        },

        snap: {
          initial: 'off',
          states: {
            off: { on: { SNAP_ON: 'on' } },
            on: { on: { SNAP_OFF: 'off' } }
          },
          on: { EXIT_EDITOR: '.off', TOGGLE_EDITOR: '.off' }
        },

        docks: {
          type: 'parallel',
          states: {
            left: {
              initial: 'expanded',
              states: {
                expanded: { on: { COLLAPSE_LEFT: 'collapsed' } },
                collapsed: { on: { EXPAND_LEFT: 'expanded' } }
              }
            },
            right: {
              initial: 'expanded',
              states: {
                expanded: { on: { COLLAPSE_RIGHT: 'collapsed' } },
                collapsed: { on: { EXPAND_RIGHT: 'expanded' } }
              }
            }
          }
        }
      }
    }
  }
})

export function createClientStateMachine() {
  const actor = createActor(clientMachine)
  actor.start()
  const snap = () => actor.getSnapshot()
  return {
    actor,
    get state() { return snap().value },
    get context() { return snap().context },
    send: (type) => actor.send(typeof type === 'string' ? { type } : type),
    matches: (s) => snap().matches(s),
    subscribe: (fn) => actor.subscribe((s) => fn(s.value, s)),
    get isReady() { return snap().matches('ready') },
    get isEditor() { return snap().matches({ ready: { mode: 'editor' } }) },
    get isLobby() { return snap().matches({ ready: { mode: 'lobby' } }) },
    get isPlaying() { return snap().matches({ ready: { mode: 'playing' } }) },
    get isPlaytesting() { return snap().matches({ ready: { mode: 'playtesting' } }) },
    get isSpectator() { return snap().matches({ ready: { mode: 'spectator' } }) },
    get spectatorSubmode() {
      const v = snap().value
      const m = v && v.ready && v.ready.mode
      return (m && typeof m === 'object' && m.spectator) ? m.spectator : null   // 'free' | 'follow' | null (not in spectator mode)
    },
    get isSelected() { return snap().matches({ ready: { select: 'selected' } }) },
    get gizmoMode() {
      const v = snap().value
      const g = v && v.ready && v.ready.gizmo
      return typeof g === 'string' ? g.replace('Drag', '') : 'translate'
    },
    get isDragging() {
      const v = snap().value
      const g = v && v.ready && v.ready.gizmo
      return typeof g === 'string' && g.endsWith('Drag')
    },
    get snapOn() { return snap().matches({ ready: { snap: 'on' } }) },
    get snapSize() { return snap().context.snapSize },
    get dockLeftCollapsed() { return snap().matches({ ready: { docks: { left: 'collapsed' } } }) },
    get dockRightCollapsed() { return snap().matches({ ready: { docks: { right: 'collapsed' } } }) },
    get editMode() { return snap().matches({ ready: { mode: 'editor' } }) },
    get headBoneHidden() { return snap().context.headBoneHidden }
  }
}
