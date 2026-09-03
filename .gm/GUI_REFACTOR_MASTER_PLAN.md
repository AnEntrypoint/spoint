# Wave C GUI Architecture Refactor - Master Plan

**Coordinator Instruction to All 4 Teams**

**Status**: ACTIVE - Use /gm to execute your section in parallel with other teams

---

## Overview

**User Requirement (Mandatory)**: 
> "all gui kit work must live in our GUI kit sdk in ../design (AnEntrypoint/design)"

**Current Problem**: All 4 teams placed UI + backend code in spoint/client/. UI must move to design kit.

**Solution**: 
1. Extract UI → AnEntrypoint/design game editor kit
2. Keep backend logic in spoint
3. Import UI via CDN importmap (no local copies)
4. Verify all components work via CDN

**Parallel Execution**: All 4 teams work independently on their features, NO coordination needed.

---

## Team-Specific Tasks

### TEAM 1: Asset Management UI → Design Kit

**What stays in spoint:**
- `src/sdk/AssetHandlers.js` (HTTP API)
- Backend asset folder hierarchy logic

**What moves to design kit:**
- `client/editor/AssetBrowser.js` → `AnEntrypoint/design/src/components/game-editor-kit/AssetBrowser.js`
- `client/editor/UploadProgress.js` → `AnEntrypoint/design/src/components/game-editor-kit/UploadProgress.js`
- `client/editor/AssetPickerModal.js` → `AnEntrypoint/design/src/components/game-editor-kit/AssetPickerModal.js`
- `client/editor/AssetManagementIntegration.js` → (if UI wrapper, move it; if backend, keep it)

**Execution (use /gm):**
1. Clone/navigate to AnEntrypoint/design repo
2. Create `src/components/game-editor-kit/` directory
3. Copy `.js` files from spoint to design kit
4. Add export in design kit's `index.js` 
5. Test design kit builds
6. Commit and push to AnEntrypoint/design main
7. Return to spoint: revert UI-adding commits, update importmap
8. Verify components load from CDN

---

### TEAM 2: Batch Operations & Damage Feedback UI → Design Kit

**What stays in spoint:**
- `src/effects/DamageEffects.js` (core event system, physics impulse)
- `apps/hit-feedback/index.js` (event bus integration)

**What moves to design kit:**
- `client/editor/BatchOperations.js` (UI panel only)
- Damage numbers/overlay rendering components

---

### TEAM 3: Live Preview & Undo UI → Design Kit

**What stays in spoint:**
- `client/editor/PersistentHistory.js` (IndexedDB persistence logic)
- `client/editor/LivePreview.js` (state tracking)
- `client/editor/EditHistory.js` (onPush callback integration)

**What moves to design kit:**
- Reset button component
- Undo history UI/visualization
- Live preview panel/controls

---

### TEAM 4: Model Browser UI → Design Kit

**What stays in spoint:**
- `src/editor/ThumbnailGenerator.js` (generation logic + worker pool)
- `src/editor/ThumbnailWorker.js` (worker thread rendering)
- `src/sdk/ModelBrowserHandler.js` (HTTP API)

**What moves to design kit:**
- `client/editor/ModelBrowser.js` (UI panel)
- `client/ui/ModelPreview.js` (3D preview viewer)
- ModelBrowserIntegration.js (if UI wrapper)

---

## Common Steps (All Teams)

### Step 1: Extract UI to Design Kit

In AnEntrypoint/design repo:
```bash
mkdir -p src/components/game-editor-kit
# Copy UI files from spoint
```

### Step 2: Update Design Kit Export

File: `src/components/game-editor-kit/index.js`
```javascript
export { default as AssetBrowser } from './AssetBrowser.js';
// ... etc for all components
```

### Step 3: Commit to Design Kit

```bash
git add src/components/game-editor-kit/
git commit -m "feat: add game editor kit UI components

Moved UI from spoint to design kit. Backend logic remains in spoint.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
git push origin main
```

### Step 4: Return to Spoint and Revert UI Commits

```bash
# Revert commits that added UI to spoint
git revert <commit-hash>
```

### Step 5: Update Spoint Importmap

File: `client/index.html`
```html
<script type="importmap">
{
  "imports": {
    "anentrypoint-design": "https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/dist/247420.js",
    "game-editor-kit": "https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/dist/game-editor-kit.js"
  }
}
</script>
```

### Step 6: Update Spoint App.js

Replace local imports:
```javascript
// Before: import { AssetBrowser } from './editor/AssetBrowser.js';
// After:
import { AssetBrowser } from 'game-editor-kit';
```

### Step 7: Verify and Commit

```bash
npm run dev
# Open http://localhost:8090
# In console: import { YourComponent } from 'game-editor-kit'
# Should work with zero errors

git add client/index.html client/app.js
git commit -m "refactor: import UI from game-editor-kit CDN

Removed UI code from spoint/client/. Now imports from design kit.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
git push origin main
```

---

## Success Verification

1. Design kit exports built successfully
2. Spoint importmap references game-editor-kit correctly
3. All UI imports from CDN work (zero console errors)
4. Zero UI code remaining in spoint/client/ (grep for document/querySelector/createElement returns nothing)
5. All features work end-to-end

---

## Timeline

- Phase 1 (Extract UI): 1h per team
- Phase 2 (Design kit build): 1h shared
- Phase 3 (Spoint wiring): 1h per team
- **Total**: ~3 hours (parallelizable)

---

Use `/gm` for all work. Report completion when all verifications pass.

**Coordinator Status**: Awaiting all 4 teams to complete refactor.
