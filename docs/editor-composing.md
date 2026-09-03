# Editor composing workflow

This documents the in-engine editor's composing feature surface as verified in the codebase
(client/editor/*, client/app.js) at the time of writing. Every item below is cited to a real
file; items requested but not found landed anywhere in the client are called out explicitly
at the end rather than assumed present.

## Add menu (`client/editor/EditorShell.js`)

- Top toolbar "Add" button and the viewport right-click/long-press context menu (see
  "Viewport context menu" below) both open the same menu via `openAddMenu(x, y, placePos)`.
- Lists 4 static primitives (Box/Sphere/Capsule/Cylinder) plus a "Prop..." submenu that fetches
  the asset manifest (`AssetManifest.js`) and lists categories, then models within a category.
- **Search**: a live text filter box (`filterMenuItems`) narrows the flat item list by substring
  match on label as you type.
- **Recent**: placements are recorded to `localStorage` (`ds-editor-add-menu-recent`, capped at 8,
  most-recent-first, deduped by key) and surfacefd at the top of the menu ahead of the filtered
  base list.
- **Keyboard nav**: the menu tracks a `_highlight` index over the flattened selectable-item list
  so arrow keys/Enter can drive selection without a mouse (see `_highlight`/`_flatItems` in
  `EditorShell.js`).

## Placement

- `onPlace`/`onPlaceModel` accept an optional `placePos` (`[x,y,z]`) override; when provided
  (e.g. from the viewport context menu's raycast-under-cursor point) it takes priority over the
  panel's own default viewport-center raycast (`_viewportCenterPlacePos` in `client/app.js`).
- Placement falls back to a position in front of the local player when the raycast misses (e.g.
  clicking sky) — see `_raycastPlacePos`.

## Gizmo (`client/editor/editor.js`)

- **Modes**: translate (`G`), rotate (`R`), scale (`Alt+S`) — bare `S` is reserved for the
  fly-camera's backward key, hence the modifier.
- **Local/world space**: `setGizmoSpace('local'|'world')` rotates the translate axes by the
  selected entity's current quaternion when in local space (`_axisVec`).
- **Precision drag**: Shift = fine (0.1x), Alt = coarse (10x) drag-delta scaling
  (`_precisionScale`).
- **Snap-to-grid**: toggleable (`X`) with selectable snap sizes, applied to nudge/drag steps.
- **Snap-to-surface**: holding Ctrl while dragging the Y axis with grid-snap off raycasts straight
  down to place the entity flush on whatever surface is under it (`editor.js` ~line 199).
- **Nudge**: arrow keys move X/Z, PageUp/PageDown move Y, one grid-snap step (or 0.25 default)
  per press, applied to the primary selection and any extra multi-selected entities together.
- **Frame/focus**: `F` frames the camera on the selected entity's bounding sphere along the
  camera's current viewing direction.

## Multi-select

- Ctrl/Shift-click on a viewport entity toggles it into `extraSelectedIds` alongside the primary
  selection; gizmo drag/rotate/scale and Delete act on the whole set.
- **Box-select**: Shift/Ctrl + drag on empty viewport space starts a marquee box-select
  (`_boxSelectActive` in `editor.js`).
- **Batch drag-reparent**: SceneHierarchy rows carry the full multi-selection as one drag payload
  (`_bulkIds`) when a selected row is dragged, and ancestor/descendant pairs in the same batch are
  filtered out (`_dedupeNonAncestors`) since reparenting an ancestor under its own descendant is
  structurally impossible.

## Hierarchy (`client/editor/SceneHierarchy.js`)

- **Icons**: a one-letter type glyph per row (`M` model, `P` primitive, `A` app, `o` other, `L`
  for lights) plus an app-name tag when it differs from the label.
- **Search scope**: the search box supports a `type:<kind>` prefix to filter by the same
  classification used for the glyph, in addition to plain substring match on id/app name.
- **Lock**: a context-menu (right-click row or the row's kebab `...` button) "Lock"/"Unlock"
  toggle. Locked entity ids live in a client-side-only `Set` (never sent to the server, never
  persisted). A locked entity is excluded from `editor.js`'s viewport raycast pick list
  (`pickEntity`), so it can't be gizmo-selected or dragged by accident, but stays selectable by
  clicking its hierarchy row directly (unlocking is only possible from there while it's locked).
- **Hide in editor**: a parallel "Hide in editor"/"Show in editor" toggle, also a client-side-only
  `Set`. While the editor overlay is open, `client/app.js`'s `entity-distance-cull` RenderGraph
  node re-applies `mesh.visible = false` for every hidden-in-editor id on top of whatever the
  game's own visibility/LOD/cull logic just decided that frame — it never mutates gameplay
  visibility state itself, and the override lapses the instant the editor closes (the game's own
  visibility resumes untouched).
- Both toggles support the current multi-selection (batch lock/hide) and show a small flag glyph
  next to a locked/hidden row's label.
- **Virtualized rendering**: above 60 rows, only the viewport + overscan rows render as real tree
  items; the rest become two sized spacer divs.
- **Drag-reparent**: dropping on the top/bottom quarter of a row reparents as a sibling; the
  middle half reparents as a child. Dropping on the panel background unparents to root.

## Inspector (`client/editor/EditorInspector.js`)

- **Numeric expression support**: typed numeric fields accept a small expression grammar
  (`allowExpr`), not just literal numbers.
- **Copy/paste value**: each position/rotation axis cell has a copy affordance and a paste button
  that applies a single in-memory numeric clipboard slot, scoped per session.
- Position/rotation are edited per-axis with drag-scrub (`useNumberScrub`) plus the copy/paste
  cells above.
- **Collapsible sections**: `sectionHeader(name, label, onToggle)` (`EditorInspector.js:33-43`)
  renders a clickable header with a rotating `▾` disclosure glyph; collapsed/expanded state lives
  in the module-level `_collapsedSections` map (`EditorInspector.js:31`) so it survives re-renders
  within the session. Transform (`EditorInspector.js:254`), Collider (`EditorInspector.js:256`),
  and App Props (`EditorInspector.js:261`) sections are each gated behind their own header; a
  collapsed section's body is skipped from the diff (`transformSection`/`colliderSection`,
  `EditorInspector.js:245-250`) or hidden via `display:none` for the app-props host
  (`EditorInspector.js:263`, kept mounted rather than unmounted so drag/focus state and the
  sig-gated rebuild in the same function aren't disturbed by a toggle).
- **Uniform-scale axis-link**: a lock/unlock button (`scaleLinkBtn`, `EditorInspector.js:235-239`)
  next to the Scale row's label toggles a per-entity `_scaleLinked` flag
  (`EditorInspector.js:132`, stored directly on the live entity object so it persists across
  re-renders and re-selection the same way `bodyType`/`collider` do). While locked, `writeScale`
  (`EditorInspector.js:133-144`) computes the ratio between the newly-typed value and the edited
  axis's prior value and applies that ratio to the other two axes, guarded against a zero
  reference axis (skips the other axes rather than dividing by zero into NaN/Infinity).

## Undo/redo (`client/editor/EditHistory.js`)

- A capped (20-entry) undo/redo stack of `{entityId, before, after, kind}` records. `undo()`
  replays the `before` change payload and moves the record to the redo stack; `redo()` replays
  `after`. Pushing a new edit clears the redo stack (a new edit forks history). Wired to
  `mod+Z`/`mod+Y` per `EditorShell.js`'s shortcuts list.

## Camera bookmarks

- `Alt+1`..`9` recalls a saved camera pose; `Ctrl+Alt+1`..`9` saves the current camera pose to
  that slot (`EDITOR_SHORTCUTS` in `EditorShell.js`).

## Error feedback toasts

- `showToast(msg, kind)` (`EditPanelDOM.js`) surfaces action failures (e.g. a context-menu action
  throwing) and confirms successful actions (rename/duplicate/delete/lock/hide/place), consistent
  across the hierarchy panel, Add menu, and inspector.

## Viewport context menu

- Right-click (or long-press on touch) on the viewport canvas, while the editor overlay is open,
  opens the same Add menu (`renderer.domElement`'s `contextmenu`/`touchstart` listeners in
  `client/app.js`), positioned at the click point.
- The click point is raycast against the scene (`_raycastHitPoint`) and, on a hit, passed through
  to `onPlace`/`onPlaceModel` as the placement position override — so "Add here" places at the
  actual point under the cursor rather than always at viewport-center. On a miss (e.g. clicking
  sky) it falls back to the panel's normal viewport-center placement.
- A "Paste" entry was not added: no clipboard/copy-entity mechanism exists in the client.

## Group-parent (`MSG.GROUP_ENTITIES`, 0xa3)

- **Server**: `src/sdk/EditorHandlers.js:468-476` — takes `{entityIds}`, calls `groupEntities()`
  which spawns a new transform-only empty entity at the selection's centroid and reparents every
  given id under it (world transform preserved by `reparent()`), persists via
  `ctx.placedModelStorage`, and replies `MSG.EDITOR_SELECT` with the new group entity's id so the
  client's selection follows the newly-created parent.
- **Client trigger**: a toolbar "Group" button in `client/editor/EditorShell.js` (next to the
  Align/Distribute button group, same `groupLabel`/`C.Btn` pattern), wired to a new `onGroup`
  callback prop threaded through `createEditPanel(...)`. `client/app.js`'s `onGroup` handler
  collects `editor.selectedEntityId` + `editor.extraSelectedIds` (the same primary+extras
  multi-selection source `onAlign`/`onDistribute` already use), requires 2+ ids (toasts otherwise,
  same convention as align/distribute's floor), and sends `client.send(MSG.GROUP_ENTITIES,
  {entityIds: ids})`.

## Prefab save/place (`MSG.SAVE_PREFAB` 0xa0, `MSG.PREFAB_SAVED` 0xa1, `MSG.PLACE_PREFAB` 0xa2)

- **Server only**: `src/sdk/EditorHandlers.js:480-514+` implements both handlers — `SAVE_PREFAB`
  serializes the given entity ids' configs relative to their selection centroid into
  `data/prefabs.json` (via `_persistPrefabs`) and replies `PREFAB_SAVED`; `PLACE_PREFAB`
  re-instantiates a saved prefab's entities at a target position, offset from the stored
  centroid-relative layout, reparented under one freshly-spawned group entity (reusing
  `groupEntities`).
- **No client trigger exists yet** — no toolbar button, context-menu entry, or shortcut in
  `client/editor/` or `client/app.js` sends `SAVE_PREFAB`/`PLACE_PREFAB`, so a maker cannot save or
  place a prefab from the GUI today. This is the one remaining gap from the original "not
  confirmed landed" list; wiring it (a "Save as Prefab..." context-menu/toolbar entry prompting
  for a name, plus a "Prefabs" category in the Add menu reading a server-provided prefab list) is
  follow-up work, not done as part of this pass.
