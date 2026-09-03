# GUI Architecture Redirect: Move to Design Kit

**Date**: 2026-08-21  
**Status**: ACTIVE REDIRECT - Waiting for team responses

## Executive Summary

User requirement: **"all gui kit work must live in our GUI kit sdk in ../design (AnEntrypoint/design)"**

All 4 Wave C teams delivered UI components in spoint/client/. This violates the architecture constraint. Components must be **moved to AnEntrypoint/design repo** (game editor kit) and imported by spoint via CDN importmap.

## Components to Move (UI → Design Kit)

### Team 1: Asset Management
**Move to design kit:**
- `client/editor/AssetBrowser.js`
- `client/editor/AssetPickerModal.js`
- `client/editor/UploadProgress.js`
- `client/editor/AssetManagementIntegration.js` (if UI wrapper)

**Keep in spoint (backend):**
- `src/sdk/AssetHandlers.js` (HTTP API)
- Asset folder hierarchy backend logic

---

### Team 2: Batch Operations & Damage Feedback
**Move to design kit:**
- `client/editor/BatchOperations.js` UI panel
- `client/hud/DamageNumbers.js` rendering (if created)
- `client/ui/DamageOverlay.js` (if created)

**Keep in spoint (backend):**
- `src/effects/DamageEffects.js` (core event/physics logic)
- Damage event bus integration
- Impulse force application logic

---

### Team 3: Live Preview & Persistent Undo
**Move to design kit:**
- `client/editor/LivePreview.js` UI panel
- Reset button and undo history UI components
- Undo history display/visualization

**Keep in spoint (backend):**
- State tracking logic (LivePreview state capture)
- `client/editor/PersistentHistory.js` IndexedDB persistence
- EditHistory integration points

---

### Team 4: Model Browser
**Move to design kit:**
- `client/editor/ModelBrowser.js`
- `client/editor/ModelBrowserIntegration.js` (if UI wrapper)
- `client/ui/ModelPreview.js`

**Keep in spoint (backend):**
- `src/editor/ThumbnailGenerator.js` (logic)
- `src/editor/ThumbnailWorker.js` (worker)
- `src/sdk/ModelBrowserHandler.js` (HTTP API)

---

## Implementation Pattern

For each component, the pattern is:

1. **Extract UI → Design Kit**
   - Move rendering/display code to `AnEntrypoint/design/src/components/game-editor-kit/`
   - Export as part of game editor kit
   - Design kit commit & push to main

2. **Keep Backend in Spoint**
   - Preserve HTTP APIs, event systems, persistence logic
   - Import UI components from design kit via importmap
   - Update spoint's importmap to include game editor kit exports
   - spoint commit removes UI code, adds importmap lines

3. **Verify Integration**
   - Spoint can reach design kit UI via CDN (no local copies)
   - No circular dependencies (design kit ← spoint backend)
   - All UI works through the same component contract

## Design Kit Export Structure

```
AnEntrypoint/design/src/components/game-editor-kit/
├── AssetBrowser.js
├── AssetPickerModal.js
├── UploadProgress.js
├── BatchOperationsPanel.js
├── DamageNumbers.js
├── LivePreviewPanel.js
├── UndoHistoryUI.js
├── ModelBrowser.js
├── ModelPreview.js
└── index.js (main export)
```

**spoint importmap example:**
```javascript
{
  "game-editor-kit": "https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/dist/game-editor-kit.js"
}
```

## Teams Status

- **Team 1** (Asset UI): Redirected ⏳ Awaiting response
- **Team 2** (Batch Ops): Redirected ⏳ Awaiting response
- **Team 3** (Live Preview): Redirected ⏳ Awaiting response
- **Team 4** (Model Browser): Redirected ⏳ Awaiting response

## Next Steps

1. Teams execute architectural refactor (move UI to design kit)
2. Design kit builds game editor kit export
3. spoint updates importmap and removes local UI code
4. Verify all components render correctly via CDN
5. Commit final state to both repos

## Blocking Gate

**Cannot commit back to spoint until:**
- All UI components are in design kit
- Design kit exports game editor kit successfully
- spoint importmap updated to reference design kit
- All components verified working via CDN import

---

This redirect ensures compliance with the architectural invariant: **single source of truth for all GUI**.
