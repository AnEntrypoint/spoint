import { h, applyDiff } from 'anentrypoint-design'
import { EventChainManager } from '/src/game/EventChainManager.js'

/**
 * createEventChainPanel
 * Full-featured visual GUI panel for editing, wiring, testing, and debugging
 * Universal Game Event Chains in the spoint editor.
 */
export function createEventChainPanel(container, {
  manager = null,
  onChainChange = null,
  onTestChain = null,
  getEntities = () => [],
  getApps = () => []
} = {}) {
  if (!container) return null

  const mgr = manager || new EventChainManager()
  let selectedChainId = null
  let logs = []
  let knownEntities = []
  let knownApps = []

  // Ensure default initial chain if empty
  if (mgr.getChains().length === 0) {
    mgr.addChain({
      id: 'chain_interact_door',
      name: 'Interactive Door / Chest Chain',
      enabled: true,
      trigger: { type: 'onInteract', entityId: '*' },
      conditions: [
        { type: 'ifVariable', variableName: 'hasKey', operator: '==', value: 'true' }
      ],
      actions: [
        { type: 'playSound', sound: 'door_open', volume: 1.0 },
        { type: 'setVariable', variableName: 'doorOpened', operator: '=', value: true },
        { type: 'triggerAnimation', clip: 'open', loop: false, fade: 0.1 }
      ]
    })
  }

  // Pre-select first chain
  const chains = mgr.getChains()
  if (chains.length > 0) {
    selectedChainId = chains[0].id
  }

  // Subscribe to manager logs
  mgr.onLog((logEntry) => {
    logs.unshift(logEntry)
    if (logs.length > 100) logs.pop()
    render()
  })

  // DOM Mount structure
  const root = document.createElement('div')
  root.className = 'ds-ep-event-chain-panel'
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;background:var(--panel-bg, #141416);color:var(--panel-text, #e0e0e0);font-family:var(--ff-mono, monospace);font-size:12px;overflow:hidden'
  container.appendChild(root)

  function updateEntitiesAndApps(entities = [], apps = []) {
    knownEntities = entities
    knownApps = apps
    render()
  }

  function render() {
    const currentChains = mgr.getChains()
    const activeChain = mgr.getChain(selectedChainId) || currentChains[0] || null

    if (activeChain && !selectedChainId) {
      selectedChainId = activeChain.id
    }

    const vnode = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden' }, [
      // Top Toolbar
      renderToolbar(currentChains, activeChain),

      // Main Split Body
      h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden' }, [
        // Left Sidebar: Chain List
        renderChainList(currentChains, activeChain),

        // Right Main Area: Node Editor & Visual Graph
        renderChainDetail(activeChain)
      ]),

      // Bottom Console / Event Logs
      renderLogConsole()
    ])

    applyDiff(root, [vnode])
  }

  // Top Toolbar
  function renderToolbar(currentChains, activeChain) {
    return h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--panel-1, #1e1e24);border-bottom:1px solid var(--rule, #2d2d35);gap:8px;flex-wrap:wrap'
    }, [
      h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        h('span', { style: 'font-weight:700;color:var(--accent, #50a0ff);font-size:13px' }, '⚡ EVENT CHAINS'),
        h('span', { style: 'font-size:10px;padding:2px 6px;border-radius:10px;background:rgba(80,160,255,0.15);color:var(--accent, #50a0ff)' }, `${currentChains.length} Chains`)
      ]),

      h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
        // New Chain Button
        h('button', {
          class: 'wm-btn',
          style: 'padding:4px 8px;font-size:11px;background:var(--accent, #50a0ff);color:#fff;border:none;border-radius:4px;cursor:pointer',
          onclick: () => {
            const newC = mgr.addChain({
              name: 'New Event Chain',
              enabled: true,
              trigger: { type: 'onInteract', entityId: '*' },
              conditions: [],
              actions: [{ type: 'playSound', sound: 'click', volume: 1.0 }]
            })
            selectedChainId = newC.id
            if (onChainChange) onChainChange(mgr.toJSON())
            render()
          }
        }, '+ New Chain'),

        // Test Selected Chain Button
        h('button', {
          class: 'wm-btn',
          style: 'padding:4px 8px;font-size:11px;background:var(--success, #28a745);color:#fff;border:none;border-radius:4px;cursor:pointer',
          disabled: !activeChain,
          onclick: () => {
            if (!activeChain) return
            const res = mgr.runChain(activeChain.id, {
              entityId: activeChain.trigger.entityId !== '*' ? activeChain.trigger.entityId : (knownEntities[0]?.id || 'demo_entity'),
              playerId: 'player_test',
              position: [0, 1, 0]
            })
            if (onTestChain) onTestChain(activeChain, res)
            render()
          }
        }, '▶ Test Chain'),

        // Preset Templates Menu
        h('select', {
          style: 'padding:4px;font-size:11px;background:var(--panel-2, #2a2a32);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px',
          onchange: (e) => {
            const template = e.target.value
            e.target.value = ''
            if (!template) return
            loadPresetTemplate(template)
          }
        }, [
          h('option', { value: '' }, '⚡ Add Preset Template...'),
          h('option', { value: 'chest' }, '🎁 Treasure Chest Unlock'),
          h('option', { value: 'teleport' }, '🌀 Zone Teleporter / Level Load'),
          h('option', { value: 'timer' }, '⏱️ Periodic Timer Spawner'),
          h('option', { value: 'collision' }, '💥 Collision Damage & Sound')
        ]),

        // Export JSON
        h('button', {
          class: 'wm-btn',
          style: 'padding:4px 8px;font-size:11px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px;cursor:pointer',
          onclick: () => {
            const jsonStr = JSON.stringify(mgr.toJSON(), null, 2)
            navigator.clipboard.writeText(jsonStr)
            alert('Event Chain JSON copied to clipboard!')
          }
        }, 'Export JSON'),

        // Import JSON
        h('button', {
          class: 'wm-btn',
          style: 'padding:4px 8px;font-size:11px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px;cursor:pointer',
          onclick: () => {
            const raw = prompt('Paste Event Chains JSON:')
            if (!raw) return
            try {
              const parsed = JSON.parse(raw)
              mgr.fromJSON(parsed)
              const first = mgr.getChains()[0]
              selectedChainId = first ? first.id : null
              if (onChainChange) onChainChange(mgr.toJSON())
              render()
            } catch (err) {
              alert('Invalid JSON: ' + err.message)
            }
          }
        }, 'Import JSON')
      ])
    ])
  }

  // Left Sidebar: Chain List
  function renderChainList(currentChains, activeChain) {
    return h('div', {
      style: 'width:240px;min-width:200px;background:var(--panel-1, #18181c);border-right:1px solid var(--rule, #2d2d35);display:flex;flex-direction:column;overflow-y:auto'
    }, [
      h('div', { style: 'padding:8px 10px;font-size:10px;font-weight:700;color:var(--panel-text-3, #888);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--rule)' }, 'CHAINS LIST'),

      currentChains.length === 0
        ? h('div', { style: 'padding:16px;text-align:center;color:var(--panel-text-3)' }, 'No event chains created.')
        : h('div', { style: 'display:flex;flex-direction:column;padding:4px' },
            currentChains.map((c) => {
              const isSelected = activeChain && activeChain.id === c.id
              return h('div', {
                style: `padding:8px 10px;margin:2px 0;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:${isSelected ? 'rgba(80,160,255,0.18)' : 'transparent'};border:${isSelected ? '1px solid var(--accent, #50a0ff)' : '1px solid transparent'}`,
                onclick: () => {
                  selectedChainId = c.id
                  render()
                }
              }, [
                h('div', { style: 'display:flex;flex-direction:column;overflow:hidden;gap:2px' }, [
                  h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
                    h('input', {
                      type: 'checkbox',
                      checked: c.enabled,
                      onclick: (e) => e.stopPropagation(),
                      onchange: (e) => {
                        c.enabled = e.target.checked
                        if (onChainChange) onChainChange(mgr.toJSON())
                        render()
                      }
                    }),
                    h('span', { style: 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--panel-text)' }, c.name || c.id)
                  ]),
                  h('div', { style: 'display:flex;align-items:center;gap:4px;font-size:9px;color:var(--panel-text-3)' }, [
                    h('span', { style: 'padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.08)' }, c.trigger?.type || 'onInteract'),
                    h('span', {}, `${c.conditions?.length || 0} Cond`),
                    h('span', {}, `${c.actions?.length || 0} Act`)
                  ])
                ]),

                // Delete Button
                h('button', {
                  style: 'background:none;border:none;color:var(--warn, #ff5555);cursor:pointer;font-size:12px;padding:2px 4px',
                  title: 'Delete Chain',
                  onclick: (e) => {
                    e.stopPropagation()
                    if (confirm(`Delete chain "${c.name}"?`)) {
                      mgr.removeChain(c.id)
                      const remaining = mgr.getChains()
                      selectedChainId = remaining[0] ? remaining[0].id : null
                      if (onChainChange) onChainChange(mgr.toJSON())
                      render()
                    }
                  }
                }, '✕')
              ])
            })
          )
    ])
  }

  // Right Main Area: Node Editor & Visual Graph
  function renderChainDetail(chain) {
    if (!chain) {
      return h('div', { style: 'flex:1;display:flex;align-items:center;justify-content:center;color:var(--panel-text-3)' }, 'Select or create an event chain to edit.')
    }

    return h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;padding:12px;gap:12px;background:var(--panel-bg, #141416)' }, [
      // Chain Meta Header
      h('div', { style: 'display:flex;align-items:center;gap:12px;background:var(--panel-1, #1e1e24);padding:10px 14px;border-radius:8px;border:1px solid var(--rule)' }, [
        h('label', { style: 'font-weight:600;font-size:11px;color:var(--panel-text-3)' }, 'Chain Name:'),
        h('input', {
          type: 'text',
          value: chain.name,
          style: 'flex:1;padding:4px 8px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px',
          oninput: (e) => {
            chain.name = e.target.value
            if (onChainChange) onChainChange(mgr.toJSON())
          }
        }),
        h('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px' }, [
          h('input', {
            type: 'checkbox',
            checked: chain.enabled,
            onchange: (e) => {
              chain.enabled = e.target.checked
              if (onChainChange) onChainChange(mgr.toJSON())
              render()
            }
          }),
          'Enabled'
        ])
      ]),

      // Visual Node Graph Wiring Diagram
      renderGraphDiagram(chain),

      // 1. TRIGGER SECTION
      renderTriggerSection(chain),

      // 2. CONDITIONS SECTION
      renderConditionsSection(chain),

      // 3. ACTIONS & DELAYS SECTION
      renderActionsSection(chain)
    ])
  }

  // Interactive Visual Wiring Diagram (SVG)
  function renderGraphDiagram(chain) {
    const triggerLabel = `Trigger: ${chain.trigger?.type || 'onInteract'} (${chain.trigger?.entityId || '*'})`
    const condCount = chain.conditions?.length || 0
    const condLabel = condCount > 0 ? `Conditions: (${condCount} checks)` : 'Conditions: (None - Always Runs)'
    const actions = chain.actions || []

    return h('div', {
      style: 'background:var(--panel-1, #1a1a20);border:1px solid var(--rule);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px'
    }, [
      h('div', { style: 'font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px' }, 'VISUAL EVENT FLOW WIRING'),
      
      h('div', { style: 'display:flex;align-items:center;gap:12px;overflow-x:auto;padding:8px 4px' }, [
        // Trigger Node Card
        h('div', {
          style: 'min-width:140px;padding:8px 12px;background:rgba(80,160,255,0.15);border:1px solid var(--accent);border-radius:6px;display:flex;flex-direction:column;gap:2px'
        }, [
          h('span', { style: 'font-size:9px;color:var(--accent);font-weight:700' }, '⚡ EVENT TRIGGER'),
          h('span', { style: 'font-weight:600;font-size:11px' }, chain.trigger?.type || 'onInteract'),
          h('span', { style: 'font-size:9px;color:var(--panel-text-3)' }, `Target: ${chain.trigger?.entityId || '*'}`)
        ]),

        // Arrow 1
        h('span', { style: 'color:var(--accent);font-size:14px;font-weight:700' }, '➔'),

        // Conditions Node Card
        h('div', {
          style: `min-width:140px;padding:8px 12px;background:${condCount > 0 ? 'rgba(255,193,7,0.15)' : 'rgba(255,255,255,0.05)'};border:1px solid ${condCount > 0 ? '#ffc107' : 'var(--rule)'};border-radius:6px;display:flex;flex-direction:column;gap:2px`
        }, [
          h('span', { style: `font-size:9px;color:${condCount > 0 ? '#ffc107' : 'var(--panel-text-3)'};font-weight:700` }, '🔍 CONDITIONS'),
          h('span', { style: 'font-weight:600;font-size:11px' }, condCount > 0 ? `${condCount} Filter Rule(s)` : 'Pass Through'),
          h('span', { style: 'font-size:9px;color:var(--panel-text-3)' }, condCount > 0 ? chain.conditions.map(c => c.type).join(', ') : 'Always True')
        ]),

        // Arrow 2
        h('span', { style: 'color:var(--accent);font-size:14px;font-weight:700' }, '➔'),

        // Actions Sequence Node Card
        h('div', {
          style: 'flex:1;min-width:180px;padding:8px 12px;background:rgba(40,167,69,0.15);border:1px solid #28a745;border-radius:6px;display:flex;flex-direction:column;gap:4px'
        }, [
          h('span', { style: 'font-size:9px;color:#28a745;font-weight:700' }, '🎯 ACTIONS SEQUENCE'),
          actions.length === 0
            ? h('span', { style: 'font-size:10px;color:var(--panel-text-3)' }, 'No actions added.')
            : h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' },
                actions.map((a, idx) => h('span', {
                  style: 'padding:2px 6px;border-radius:3px;background:rgba(40,167,69,0.25);font-size:10px;color:#fff;border:1px solid #28a745'
                }, `${idx + 1}. ${a.type}${a.delay ? ` (${a.delay}s delay)` : ''}`))
              )
        ])
      ])
    ])
  }

  // 1. Trigger Section
  function renderTriggerSection(chain) {
    const trigger = chain.trigger || { type: 'onInteract', entityId: '*' }

    return h('div', {
      style: 'background:var(--panel-1, #1e1e24);border:1px solid var(--rule);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px'
    }, [
      h('div', { style: 'font-size:11px;font-weight:700;color:var(--accent);display:flex;align-items:center;gap:6px' }, [
        '⚡ STEP 1: EVENT TRIGGER',
        h('span', { style: 'font-size:9px;color:var(--panel-text-3)' }, '(Defines when this chain fires)')
      ]),

      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' }, [
        // Trigger Type
        h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [
          h('label', { style: 'font-size:10px;color:var(--panel-text-3)' }, 'Trigger Event Type:'),
          h('select', {
            style: 'padding:5px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px',
            value: trigger.type,
            onchange: (e) => {
              trigger.type = e.target.value
              chain.trigger = trigger
              if (onChainChange) onChainChange(mgr.toJSON())
              render()
            }
          }, [
            h('option', { value: 'onInteract' }, 'onInteract (Player presses E on entity)'),
            h('option', { value: 'onEnterZone' }, 'onEnterZone (Player enters trigger volume)'),
            h('option', { value: 'onTimer' }, 'onTimer (Interval or scheduled timer)'),
            h('option', { value: 'onDestroy' }, 'onDestroy (Entity destroyed or despawned)'),
            h('option', { value: 'onCollision' }, 'onCollision (Physics collision impact)')
          ])
        ]),

        // Target Entity ID
        h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [
          h('label', { style: 'font-size:10px;color:var(--panel-text-3)' }, 'Source Entity / Filter:'),
          h('select', {
            style: 'padding:5px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px',
            value: trigger.entityId || '*',
            onchange: (e) => {
              trigger.entityId = e.target.value
              chain.trigger = trigger
              if (onChainChange) onChainChange(mgr.toJSON())
              render()
            }
          }, [
            h('option', { value: '*' }, '* (Any Entity / Global)'),
            ...knownEntities.map(ent => h('option', { value: ent.id }, `${ent.id} (${ent.appName || ent.model || 'entity'})`))
          ])
        ])
      ]),

      // Type Specific Secondary Input
      trigger.type === 'onEnterZone' ? h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:4px' }, [
        h('label', { style: 'font-size:10px;color:var(--panel-text-3)' }, 'Zone ID:'),
        h('input', {
          type: 'text',
          value: trigger.zoneId || '*',
          placeholder: 'zone_01 or *',
          style: 'padding:4px 8px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px',
          oninput: (e) => {
            trigger.zoneId = e.target.value
            if (onChainChange) onChainChange(mgr.toJSON())
          }
        })
      ]) : null,

      trigger.type === 'onTimer' ? h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:4px' }, [
        h('label', { style: 'font-size:10px;color:var(--panel-text-3)' }, 'Timer ID:'),
        h('input', {
          type: 'text',
          value: trigger.timerId || 'timer_main',
          style: 'padding:4px 8px;background:var(--panel-2);color:var(--panel-text);border:1px solid var(--rule);border-radius:4px',
          oninput: (e) => {
            trigger.timerId = e.target.value
            if (onChainChange) onChainChange(mgr.toJSON())
          }
        })
      ]) : null
    ])
  }

  // 2. Conditions Section
  function renderConditionsSection(chain) {
    const conditions = chain.conditions || []

    return h('div', {
      style: 'background:var(--panel-1, #1e1e24);border:1px solid var(--rule);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px'
    }, [
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between' }, [
        h('div', { style: 'font-size:11px;font-weight:700;color:#ffc107;display:flex;align-items:center;gap:6px' }, [
          '🔍 STEP 2: CONDITIONS (FILTERS)',
          h('span', { style: 'font-size:9px;color:var(--panel-text-3)' }, '(All must pass for actions to execute)')
        ]),

        h('button', {
          class: 'wm-btn',
          style: 'padding:3px 8px;font-size:10px;background:rgba(255,193,7,0.2);color:#ffc107;border:1px solid #ffc107;border-radius:4px;cursor:pointer',
          onclick: () => {
            conditions.push({ type: 'ifVariable', variableName: 'score', operator: '>=', value: '10' })
            chain.conditions = conditions
            if (onChainChange) onChainChange(mgr.toJSON())
            render()
          }
        }, '+ Add Condition')
      ]),

      conditions.length === 0
        ? h('div', { style: 'padding:8px;font-size:10px;color:var(--panel-text-3);font-style:italic' }, 'No conditions set. Chain will always execute on trigger.')
        : h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
            conditions.map((cond, idx) => h('div', {
              style: 'display:flex;align-items:center;gap:8px;padding:6px;background:var(--panel-2);border:1px solid var(--rule);border-radius:4px;flex-wrap:wrap'
            }, [
              // Condition Type
              h('select', {
                style: 'padding:3px;font-size:11px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
                value: cond.type,
                onchange: (e) => {
                  cond.type = e.target.value
                  if (onChainChange) onChainChange(mgr.toJSON())
                  render()
                }
              }, [
                h('option', { value: 'ifVariable' }, 'If Variable'),
                h('option', { value: 'ifItemInInventory' }, 'If Item in Inventory')
              ]),

              // Variable or Item Name Inputs
              cond.type === 'ifVariable' ? h('input', {
                type: 'text',
                placeholder: 'variableName',
                value: cond.variableName || 'score',
                style: 'width:100px;padding:3px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
                oninput: (e) => {
                  cond.variableName = e.target.value
                  if (onChainChange) onChainChange(mgr.toJSON())
                }
              }) : h('input', {
                type: 'text',
                placeholder: 'itemId (key_gold)',
                value: cond.itemId || 'key_gold',
                style: 'width:110px;padding:3px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
                oninput: (e) => {
                  cond.itemId = e.target.value
                  if (onChainChange) onChainChange(mgr.toJSON())
                }
              }),

              // Operator Select
              h('select', {
                style: 'padding:3px;font-size:11px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
                value: cond.operator || '==',
                onchange: (e) => {
                  cond.operator = e.target.value
                  if (onChainChange) onChainChange(mgr.toJSON())
                  render()
                }
              }, [
                h('option', { value: '==' }, '=='),
                h('option', { value: '!=' }, '!='),
                h('option', { value: '>' }, '>'),
                h('option', { value: '<' }, '<'),
                h('option', { value: '>=' }, '>='),
                h('option', { value: '<=' }, '<='),
                h('option', { value: 'contains' }, 'contains')
              ]),

              // Target Value
              h('input', {
                type: 'text',
                placeholder: 'Target Value',
                value: cond.value !== undefined ? cond.value : (cond.count !== undefined ? cond.count : '1'),
                style: 'width:80px;padding:3px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
                oninput: (e) => {
                  if (cond.type === 'ifItemInInventory') cond.count = e.target.value
                  else cond.value = e.target.value
                  if (onChainChange) onChainChange(mgr.toJSON())
                }
              }),

              // Remove Condition
              h('button', {
                style: 'background:none;border:none;color:var(--warn, #ff5555);cursor:pointer;margin-left:auto',
                onclick: () => {
                  conditions.splice(idx, 1)
                  chain.conditions = conditions
                  if (onChainChange) onChainChange(mgr.toJSON())
                  render()
                }
              }, '✕')
            ]))
          )
    ])
  }

  // 3. Actions & Delays Section
  function renderActionsSection(chain) {
    const actions = chain.actions || []

    return h('div', {
      style: 'background:var(--panel-1, #1e1e24);border:1px solid var(--rule);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px'
    }, [
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between' }, [
        h('div', { style: 'font-size:11px;font-weight:700;color:#28a745;display:flex;align-items:center;gap:6px' }, [
          '🎯 STEP 3: ACTIONS & DELAYS',
          h('span', { style: 'font-size:9px;color:var(--panel-text-3)' }, '(Executed sequentially when triggered & conditions pass)')
        ]),

        h('button', {
          class: 'wm-btn',
          style: 'padding:3px 8px;font-size:10px;background:rgba(40,167,69,0.2);color:#28a745;border:1px solid #28a745;border-radius:4px;cursor:pointer',
          onclick: () => {
            actions.push({ type: 'playSound', sound: 'coin_pickup', volume: 1.0 })
            chain.actions = actions
            if (onChainChange) onChainChange(mgr.toJSON())
            render()
          }
        }, '+ Add Action')
      ]),

      actions.length === 0
        ? h('div', { style: 'padding:8px;font-size:10px;color:var(--panel-text-3);font-style:italic' }, 'No actions defined.')
        : h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
            actions.map((act, idx) => h('div', {
              style: 'display:flex;flex-direction:column;gap:4px;padding:8px;background:var(--panel-2);border:1px solid var(--rule);border-radius:6px'
            }, [
              h('div', { style: 'display:flex;align-items:center;justify-content:space-between' }, [
                h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
                  h('span', { style: 'font-weight:700;color:#28a745' }, `${idx + 1}.`),
                  
                  // Action Type Selector
                  h('select', {
                    style: 'padding:3px 6px;font-size:11px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px;font-weight:600',
                    value: act.type,
                    onchange: (e) => {
                      act.type = e.target.value
                      if (onChainChange) onChainChange(mgr.toJSON())
                      render()
                    }
                  }, [
                    h('option', { value: 'playSound' }, 'playSound (Play sound asset)'),
                    h('option', { value: 'spawnPrefab' }, 'spawnPrefab (Spawn app/entity)'),
                    h('option', { value: 'setVariable' }, 'setVariable (Update state variable)'),
                    h('option', { value: 'triggerAnimation' }, 'triggerAnimation (Play VRM/mesh clip)'),
                    h('option', { value: 'loadLevel' }, 'loadLevel (Switch level/scene)'),
                    h('option', { value: 'emitParticle' }, 'emitParticle (Burst FX)'),
                    h('option', { value: 'delay' }, 'delay (Wait duration in seconds)')
                  ])
                ]),

                h('div', { style: 'display:flex;align-items:center;gap:4px' }, [
                  // Reorder buttons
                  h('button', {
                    disabled: idx === 0,
                    style: 'padding:2px 4px;font-size:10px;background:none;border:1px solid var(--rule);color:var(--panel-text);border-radius:3px;cursor:pointer',
                    onclick: () => {
                      const temp = actions[idx]
                      actions[idx] = actions[idx - 1]
                      actions[idx - 1] = temp
                      if (onChainChange) onChainChange(mgr.toJSON())
                      render()
                    }
                  }, '▲'),
                  h('button', {
                    disabled: idx === actions.length - 1,
                    style: 'padding:2px 4px;font-size:10px;background:none;border:1px solid var(--rule);color:var(--panel-text);border-radius:3px;cursor:pointer',
                    onclick: () => {
                      const temp = actions[idx]
                      actions[idx] = actions[idx + 1]
                      actions[idx + 1] = temp
                      if (onChainChange) onChainChange(mgr.toJSON())
                      render()
                    }
                  }, '▼'),

                  // Remove action
                  h('button', {
                    style: 'background:none;border:none;color:var(--warn, #ff5555);cursor:pointer;font-size:12px;margin-left:4px',
                    onclick: () => {
                      actions.splice(idx, 1)
                      chain.actions = actions
                      if (onChainChange) onChainChange(mgr.toJSON())
                      render()
                    }
                  }, '✕')
                ])
              ]),

              // Action Parameters Detail Box
              renderActionDetailFields(act)
            ]))
          )
    ])
  }

  // Render fields specific to each action type
  function renderActionDetailFields(act) {
    switch (act.type) {
      case 'playSound':
        return h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Sound Name:'),
          h('input', {
            type: 'text',
            value: act.sound || 'coin_pickup',
            style: 'flex:1;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.sound = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          }),
          h('label', {}, 'Volume:'),
          h('input', {
            type: 'number',
            step: '0.1',
            min: '0',
            max: '1',
            value: act.volume !== undefined ? act.volume : 1.0,
            style: 'width:50px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.volume = Number(e.target.value); if (onChainChange) onChainChange(mgr.toJSON()) }
          })
        ])

      case 'spawnPrefab':
        return h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Prefab / App:'),
          h('select', {
            style: 'padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            value: act.prefabId || 'box-static',
            onchange: (e) => { act.prefabId = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          }, [
            h('option', { value: 'box-static' }, 'box-static'),
            h('option', { value: 'placed-model' }, 'placed-model'),
            h('option', { value: 'trigger-volume' }, 'trigger-volume'),
            ...knownApps.map(a => h('option', { value: a }, a))
          ]),
          h('label', {}, 'Pos Offset:'),
          h('input', {
            type: 'text',
            placeholder: '0,1,0',
            value: Array.isArray(act.position) ? act.position.join(',') : '0,0,0',
            style: 'width:70px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => {
              act.position = e.target.value.split(',').map(n => Number(n.trim()) || 0)
              if (onChainChange) onChainChange(mgr.toJSON())
            }
          })
        ])

      case 'setVariable':
        return h('div', { style: 'display:flex;align-items:center;gap:6px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Var Name:'),
          h('input', {
            type: 'text',
            value: act.variableName || 'score',
            style: 'width:90px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.variableName = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          }),
          h('select', {
            style: 'padding:2px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            value: act.operator || '=',
            onchange: (e) => { act.operator = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          }, [
            h('option', { value: '=' }, '='),
            h('option', { value: '+=' }, '+='),
            h('option', { value: '-=' }, '-='),
            h('option', { value: 'toggle' }, 'toggle')
          ]),
          h('input', {
            type: 'text',
            value: act.value !== undefined ? act.value : 'true',
            style: 'width:70px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.value = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          })
        ])

      case 'triggerAnimation':
        return h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Clip Name:'),
          h('input', {
            type: 'text',
            value: act.clip || 'open',
            style: 'flex:1;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.clip = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          }),
          h('label', {}, 'Fade (s):'),
          h('input', {
            type: 'number',
            step: '0.05',
            value: act.fade !== undefined ? act.fade : 0.15,
            style: 'width:50px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.fade = Number(e.target.value); if (onChainChange) onChainChange(mgr.toJSON()) }
          })
        ])

      case 'loadLevel':
        return h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Level / Scene ID:'),
          h('input', {
            type: 'text',
            value: act.levelId || 'arena_level_02',
            style: 'flex:1;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.levelId = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          })
        ])

      case 'emitParticle':
        return h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Type:'),
          h('input', {
            type: 'text',
            value: act.particleType || 'spark',
            style: 'width:70px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.particleType = e.target.value; if (onChainChange) onChainChange(mgr.toJSON()) }
          }),
          h('label', {}, 'Count:'),
          h('input', {
            type: 'number',
            value: act.count !== undefined ? act.count : 15,
            style: 'width:50px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => { act.count = Number(e.target.value); if (onChainChange) onChainChange(mgr.toJSON()) }
          })
        ])

      case 'delay':
        return h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:10px;margin-top:4px' }, [
          h('label', {}, 'Delay Duration (seconds):'),
          h('input', {
            type: 'number',
            step: '0.1',
            min: '0',
            value: act.duration !== undefined ? act.duration : (act.delay || 1.0),
            style: 'width:70px;padding:2px 4px;background:var(--panel-1);color:var(--panel-text);border:1px solid var(--rule);border-radius:3px',
            oninput: (e) => {
              act.duration = Number(e.target.value)
              act.delay = act.duration
              if (onChainChange) onChainChange(mgr.toJSON())
            }
          })
        ])

      default:
        return null
    }
  }

  // Bottom Console / Event Logs
  function renderLogConsole() {
    return h('div', {
      style: 'height:100px;background:var(--panel-1, #141418);border-top:1px solid var(--rule);display:flex;flex-direction:column;overflow:hidden'
    }, [
      h('div', { style: 'display:flex;align-items:center;justify-style:space-between;padding:4px 8px;background:var(--panel-2);border-bottom:1px solid var(--rule)' }, [
        h('span', { style: 'font-size:9px;font-weight:700;color:var(--accent);letter-spacing:1px' }, 'EXECUTION LOG & TEST CONSOLE'),
        h('button', {
          style: 'background:none;border:none;color:var(--panel-text-3);font-size:9px;cursor:pointer',
          onclick: () => {
            logs = []
            mgr.clearLogs()
            render()
          }
        }, 'Clear Console')
      ]),

      h('div', { style: 'flex:1;overflow-y:auto;padding:6px 10px;font-size:10px;display:flex;flex-direction:column;gap:2px' },
        logs.length === 0
          ? [h('div', { style: 'color:var(--panel-text-3);font-style:italic' }, 'No event chain triggers logged yet. Click "▶ Test Chain" to simulate.')]
          : logs.map((l) => h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
              h('span', { style: 'color:var(--panel-text-3);font-size:9px' }, new Date(l.timestamp).toLocaleTimeString()),
              h('span', { style: `font-weight:600;color:${l.type.includes('failed') ? 'var(--warn)' : 'var(--accent)'}` }, `[${l.type}]`),
              h('span', { style: 'color:var(--panel-text-2)' }, JSON.stringify(l.details || {}))
            ]))
      )
    ])
  }

  // Preset Template Loader
  function loadPresetTemplate(type) {
    if (type === 'chest') {
      const c = mgr.addChain({
        name: 'Treasure Chest Key Unlock',
        enabled: true,
        trigger: { type: 'onInteract', entityId: '*' },
        conditions: [
          { type: 'ifItemInInventory', itemId: 'key_gold', operator: '>=', count: 1 }
        ],
        actions: [
          { type: 'playSound', sound: 'chest_unlock', volume: 1.0 },
          { type: 'setVariable', variableName: 'chestOpen', operator: '=', value: true },
          { type: 'spawnPrefab', prefabId: 'gold_coin', position: [0, 1, 0] },
          { type: 'emitParticle', particleType: 'spark', count: 25 }
        ]
      })
      selectedChainId = c.id
    } else if (type === 'teleport') {
      const c = mgr.addChain({
        name: 'Zone Teleporter & Level Load',
        enabled: true,
        trigger: { type: 'onEnterZone', zoneId: 'portal_zone_01' },
        conditions: [],
        actions: [
          { type: 'playSound', sound: 'teleport_warp', volume: 1.0 },
          { type: 'emitParticle', particleType: 'portal', count: 40 },
          { type: 'delay', duration: 0.5 },
          { type: 'loadLevel', levelId: 'level_dungeon_02' }
        ]
      })
      selectedChainId = c.id
    } else if (type === 'timer') {
      const c = mgr.addChain({
        name: 'Periodic Spawner Timer',
        enabled: true,
        trigger: { type: 'onTimer', timerId: 'spawner_timer' },
        conditions: [
          { type: 'ifVariable', variableName: 'enemyCount', operator: '<', value: 5 }
        ],
        actions: [
          { type: 'spawnPrefab', prefabId: 'box-static', position: [0, 2, 0] },
          { type: 'setVariable', variableName: 'enemyCount', operator: '+=', value: 1 }
        ]
      })
      selectedChainId = c.id
    } else if (type === 'collision') {
      const c = mgr.addChain({
        name: 'Collision Damage & Sound FX',
        enabled: true,
        trigger: { type: 'onCollision', entityId: '*' },
        conditions: [],
        actions: [
          { type: 'playSound', sound: 'impact_thud', volume: 0.8 },
          { type: 'emitParticle', particleType: 'dust', count: 10 }
        ]
      })
      selectedChainId = c.id
    }

    if (onChainChange) onChainChange(mgr.toJSON())
    render()
  }

  // Initial render call
  render()

  return {
    manager: mgr,
    updateEntitiesAndApps,
    refresh: render,
    destroy() {
      applyDiff(root, [])
      root.remove()
    }
  }
}
