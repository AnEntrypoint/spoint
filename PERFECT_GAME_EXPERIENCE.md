# Perfect Game Creation & Editing Experience - Master Roadmap

**Generated**: 2026-08-21  
**Goal**: Achieve perfect game creation/editing UX through comprehensive multi-wave implementation  
**Methodology**: 10-dimension audit → prioritized synthesis → parallel agent-driven implementation

---

## Executive Summary

### Current State
- **Editor**: Sophisticated gizmo system, high creation friction (missing app scaffolding, prefabs, batch operations)
- **Apps**: 40+ production-quality apps, critical gaps in skeletal animation, navmesh pathfinding, particle system
- **Networking**: Production-ready for co-op, race condition in e2e join blocks competitive testing
- **Assets**: Technical pipeline excellent, UX friction critical (no folder hierarchy, progress UI, format support)
- **Rendering**: WebGL2 production-ready, mid-range visual tier (missing particles, temporal AA, sky, decals)
- **Documentation**: Good basics, critical gaps in TypeScript support, physics tuning, networking patterns

### Maturity Scorecard
| Dimension | Score | Status |
|-----------|-------|--------|
| Editor UX | 6/10 | Sophisticated gizmos, high friction for new users |
| Game Templates | 4/10 | FPS strong, RPG progression missing entirely |
| Asset Pipeline | 7/10 | Technical excellence, UX friction critical |
| Networking | 7/10 | Production co-op, competitive blocked |
| App Ecosystem | 7/10 | 40+ apps, animation/navigation/particles missing |
| Rendering | 7/10 | Production WebGL2, mid-range visual tier |
| UI/UX Patterns | 7/10 | 10 components, accessibility weak |
| Performance Tooling | 7/10 | Frame metrics strong, automation weak |
| Documentation | 5/10 | Good basics, advanced topics sparse |
| Deployment | TBD | Final audit in progress |

---

## Critical Blockers (Must Fix First)

These items MUST be completed before any downstream work can proceed efficiently:

### 1. **E2E Networking Race Condition** (Blocker for Multiplayer Testing)
- **Issue**: `e2e-cross-client-remote-player-null-flake` — intermittent desync where remote player snapshot becomes null
- **Impact**: Blocks all multiplayer verification, makes competitive games untestable
- **Root Cause**: Race condition in join/snapshot flow (pre-existing, not caused by recent changes)
- **Effort**: 16 hours
- **Verification**: 10 consecutive e2e runs pass without flake
- **Enables**: Competitive multiplayer testing, confident ship of networked games

### 2. **Editor App Scaffolding & Templates** (Blocker for Creator Velocity)
- **Issue**: New developers must manually create app file structure; no guided wizard or templates
- **Impact**: 30-60 minute setup for every new app; discourages rapid iteration
- **Scope**: 
  - Generate app files from templates (simple, physics, interactive, fsm-game)
  - CLI: `npx spoint create-app --template <name> <appname>`
  - Auto-create server hook structure, client setup, hot-reload
- **Effort**: 24 hours
- **Verification**: Create 5 sample apps from each template in <2min each
- **Enables**: Rapid app creation, tutorial completion, new developer onboarding

### 3. **Asset Folder Hierarchy & Organization** (Blocker for Scaled Development)
- **Issue**: All assets flatten to `data/models/<uuid>` with no folders, tags, or search
- **Impact**: Libraries with 100+ assets become unmanageable; creators lose track of assets
- **Scope**:
  - Folder tree UI in editor
  - Asset tagging system
  - Search by name/tag
  - Bulk rename/move/delete
- **Effort**: 40 hours (20 backend, 20 editor UI)
- **Verification**: Organize 100-asset library in <5min, search for asset by tag
- **Enables**: Scaled game development, asset library management

### 4. **RPG Progression Framework** (Blocker for 30% of Game Genres)
- **Issue**: Zero support for XP/leveling/quests; entire RPG/MOBA/progression-game genres blocked
- **Scope**:
  - XP system with level thresholds
  - Ability/skill unlocks on level-up
  - Quest framework (start/complete/reward)
  - Loadout/build persistence
- **Effort**: 32 hours (template + example game)
- **Verification**: Complete tutorial quest chain, earn XP, level up, unlock ability
- **Enables**: RPG games, MOBA games, progression-based games

---

## High-Impact Implementation Waves

### Wave A: Quick Wins + Blockers (Week 1, ~40h)

**Focus**: Unblock core creator velocity + fix critical bugs

| Item | Effort | ROI | Status |
|------|--------|-----|--------|
| **P0: E2E networking race fix** | 16h | CRITICAL | Implementation ready |
| **P0: Editor app scaffolding** | 24h | CRITICAL | Implementation ready |
| **P1: TypeScript type definitions** | 6h | 1.67/h | Implementation ready |
| **P1: Asset folder hierarchy (backend)** | 20h | 0.5/h | Depends on other items |

**Parallelizable**: Networking fix + app scaffolding + TypeScript defs (independent)

**Success Criteria**:
- ✅ 10 consecutive e2e runs pass
- ✅ New app created from template in <2min
- ✅ IDE IntelliSense works for ctx/engine APIs
- ✅ Assets can be organized in folders

---

### Wave B: High-Impact Medium-Effort (Week 2-3, ~60h)

**Focus**: Enable game genre breadth + improve asset/editor workflow

| Item | Effort | ROI | Unlocks |
|------|--------|-----|---------|
| **RPG progression framework** | 32h | 0.9/h | RPG/MOBA/progression games |
| **Asset folder hierarchy (UI)** | 20h | 0.5/h | Scaled development |
| **Skeletal animation system** | 40h | 0.75/h | Humanoid animations, character control |
| **Editor prefab system** | 32h | 0.6/h | Reusable entity compositions |
| **Live preview in inspector** | 20h | 0.75/h | Faster iteration |
| **Particle system (pooled, GPU)** | 32h | 0.6/h | Visual effects, explosions |

**Parallelizable**: RPG framework, skeletal animator, particle system (independent)

**Bottleneck**: Skeletal animator enables more AI/NPC work downstream

---

### Wave C: Major Features (Week 4+, ongoing)

**Focus**: Visual fidelity + accessibility + advanced mechanics

| Item | Effort | Priority |
|------|--------|----------|
| Navmesh + pathfinding | 40h | P1 (enables RTS/dungeon games) |
| Gamepad input system | 8h | P1 (accessibility) |
| Colorblind modes | 4h | P1 (accessibility) |
| Batch align/distribute | 16h | P2 (editor polish) |
| Model browser with thumbnails | 16h | P2 (asset discovery) |
| Temporal anti-aliasing | 24h | P2 (visual quality) |
| In-game debugger overlay | 8h | P2 (performance profiling) |
| Network inspector panel | 5h | P2 (debugging) |
| Damage feedback effects | 6h | P3 (game feel) |
| Dynamic sky system | 16h | P3 (visual immersion) |

---

## Implementation Teams (Parallel Execution)

### Team A: Core Stability & Creator Velocity
- **Lead**: Sonnet agent "Networking Fix Specialist"
- **Work**: E2E race condition fix + networking verification
- **Duration**: 16h (1-2 days)
- **Exit Criteria**: 10 consecutive e2e passes

### Team B: Editor Scaffolding & DX
- **Lead**: Sonnet agent "Editor Tooling Specialist"
- **Work**: App scaffolding CLI + templates + TypeScript defs
- **Duration**: 30h (2-3 days)
- **Exit Criteria**: Create 5 sample apps from each template in <2min

### Team C: Game Mechanics - Progression
- **Lead**: Sonnet agent "Game Systems Specialist"
- **Work**: RPG framework (XP/leveling/quests/loadouts) + tutorial game
- **Duration**: 32h (3-4 days)
- **Exit Criteria**: Complete tutorial quest chain, level up, unlock abilities

### Team D: Asset Management
- **Lead**: Sonnet agent "Asset Pipeline Specialist"
- **Work**: Folder hierarchy (backend + UI) + asset upload progress UI + format support
- **Duration**: 60h (4-5 days)
- **Exit Criteria**: Organize 100-asset library, upload GLB with progress feedback

### Team E: Core Mechanics - Animation & Effects
- **Lead**: Sonnet agent "Rendering Specialist"
- **Work**: Skeletal animator (FK/IK/blend trees) + particle system
- **Duration**: 72h (4-5 days)
- **Exit Criteria**: Humanoid character animates, particle effects render

### Team F: Navigation & AI
- **Lead**: Sonnet agent "AI & Navigation Specialist"
- **Work**: Navmesh baking + pathfinding + improved combat-bot AI
- **Duration**: 40h (3-4 days)
- **Exit Criteria**: NPC navigates multi-room dungeon, patrols waypoints

---

## Dependency Graph

```
Wave A (Blockers):
  E2E Networking Fix ──────┐
  App Scaffolding ──────┬──┤ Wave B Ready
  TypeScript Defs ──────┘  │
  Asset Folder Hierarchy ──┘

Wave B (High-Impact):
  RPG Framework ────────────┐
  Skeletal Animator ────┬───┤ Wave C Ready
  Particle System ──────┘   │
  Editor Prefabs ───────────┤
  Live Preview ─────────────┘

Wave C (Major Features):
  Navmesh + Pathfinding ────┐
  Gamepad Input ────────┬───┤ Multiplayer Expansion
  Colorblind Modes ─────┘   │
  Model Browser ────────────┤
  Temporal AA ───────────────┤
  Sky System ────────────────┘
```

---

## Success Metrics (Perfect Experience Definition)

### Creator Onboarding
- [ ] New developer can create playable game in <30 minutes
- [ ] Tutorial game runs without errors
- [ ] Editor app creation takes <2 minutes
- [ ] All editor features have visible hints/tooltips

### Game Genre Coverage
- [ ] Can create: FPS, RPG, Puzzle, Platformer, Roguelike, Tower Defense, Co-op
- [ ] Can't create: Single-player narrative (not a priority)
- [ ] Multiplayer games tested and verified stable

### Asset Management
- [ ] Assets organized in folders, not UUID lists
- [ ] Asset upload shows progress and preview
- [ ] Can organize 100+ assets in <5 minutes
- [ ] Import VRM, GLB, OBJ (or clear docs why OBJ unsupported)

### Editor UX
- [ ] Can edit complex scene (50+ entities) without slowdown
- [ ] Undo history persists across sessions (100+ entries)
- [ ] Batch operations work (multi-select align, distribute, duplicate)
- [ ] Live preview shows property changes in viewport

### Visual Fidelity
- [ ] Humanoid characters animate smoothly
- [ ] Particle effects render efficiently
- [ ] No visual glitches (tree flicker, degenerate triangles resolved)
- [ ] Colorblind players can see all UI clearly
- [ ] Gamepad players can navigate menus

### Networking & Multiplayer
- [ ] Co-op games sync player state smoothly (<100ms latency)
- [ ] Competitive games verified stable (10 consecutive plays)
- [ ] Player join/leave doesn't cause visible desync
- [ ] Network lag visible to players (not silent)

### Documentation
- [ ] TypeScript support with full IDE IntelliSense
- [ ] Physics tuning guide with examples
- [ ] Networking patterns documented
- [ ] Performance profiling guide with examples
- [ ] Getting started in <30 minutes

---

## Resource Allocation

**Total Effort**: ~400 hours (5 weeks at 80h/week, 6 parallel teams)

**Recommended Team Structure**:
- 6 Sonnet specialist agents (parallel)
- 1 Coordinator agent (synthesis, verification)
- 1 Integration agent (merge, test, ship)

**Estimated Timeline**:
- Week 1: Blockers + quick wins (40h)
- Week 2-3: High-impact features (120h)
- Week 4+: Major features + polish (ongoing)

**Success Criteria**: 
- By end of Week 1: Stable multiplayer testing, new developers can scaffold apps in <2min
- By end of Week 3: Can create RPG, FPS, Tower Defense, Roguelike, Co-op games
- By end of Week 5: Visual fidelity + accessibility complete, documentation full

---

## Architectural Constraint (2026-08-21)

**CRITICAL RULE**: All GUI/UI components must live in **AnEntrypoint/design** repository.

This is enforced via:
- Code review: Reject UI in spoint source
- CI/CD: Fail deploy if new UI components in spoint/client/
- Single source of truth: One design kit for all AnEntrypoint products

**Wave C Refactor** (2026-08-21 onwards):
Teams 1, 2, 3, 4 delivered backend + UI code together. UI must now be extracted to design kit:

| Team | Feature | Status | Next Step |
|------|---------|--------|-----------|
| 1 | Asset Browser | Backend ✅ UI in wrong place | Move UI → design kit |
| 2 | Batch Ops & Damage FX | Backend ✅ UI in wrong place | Move UI → design kit |
| 3 | Live Preview & Undo | Backend ✅ UI in wrong place | Move UI → design kit |
| 4 | Model Browser | Backend ✅ UI in wrong place | Move UI → design kit |

See `.gm/GUI_ARCHITECTURE_REDIRECT.md` for detailed refactor plan.

## Stop Condition

Work continues until:
- ✅ All 7 game genres supported with examples
- ✅ Editor UX friction reduced to <15 minutes for complex scene setup
- ✅ Asset management supports 500+ asset libraries
- ✅ Multiplayer verified stable under real network conditions
- ✅ Visual quality matches AAA standard for open-world games
- ✅ Documentation enables new developer to ship game in 2 weeks
- ✅ Accessibility passes WCAG 2.1 Level AA
- ✅ **ALL GUI components live in AnEntrypoint/design (architectural constraint)**

This document is the active roadmap. Update after each wave completion.
