# Model Browser Implementation Guide

Complete step-by-step guide for integrating the Model Browser system into spoint.

## Quick Start (5 minutes)

### 1. Install Dependencies

```bash
npm install three canvas
```

### 2. Register HTTP API Routes

Add to your server initialization (`src/index.server.js`):

```javascript
import { registerModelBrowserRoutes } from 'src/sdk/ModelBrowserHandler.js'

// In your server setup code, after creating httpServer:
registerModelBrowserRoutes(httpServer, {
  glbDir: 'apps/maps',      // Where your .glb files are
  cacheDir: '.thumbnail-cache'
})
```

### 3. Create Browser Panel

Add to your editor (`client/editor/EditorShell.js` or panel initialization):

```javascript
import { initializeModelBrowserPanel } from './ModelBrowserIntegration.js'

const panelContainer = document.createElement('div')
const { browser, refresh, destroy } = initializeModelBrowserPanel(
  panelContainer,
  {
    placeModel: (modelConfig) => {
      // Your scene placement logic
      console.log('Place model:', modelConfig.path)
    }
  }
)
```

## Detailed Integration Steps

### Step 1: API Endpoint Setup

#### In `src/index.server.js`:

```javascript
import { registerModelBrowserRoutes } from './sdk/ModelBrowserHandler.js'

export async function createServer(opts = {}) {
  const httpServer = http.createServer((req, res) => {
    // Your existing request handler
    const url = new URL(req.url, `http://${req.headers.host}`)
    
    // Model browser endpoints handled via registerModelBrowserRoutes
    // ... rest of your handler
  })

  // Register all model browser routes
  registerModelBrowserRoutes(httpServer, {
    glbDir: path.join(process.cwd(), 'apps', 'maps'),
    cacheDir: path.join(process.cwd(), '.thumbnail-cache')
  })

  return httpServer
}
```

#### Optional: Pre-warm Thumbnails at Startup

```javascript
import { ThumbnailGenerator } from './editor/ThumbnailGenerator.js'

export async function createServer(opts = {}) {
  // ... your server setup ...

  // Pre-generate thumbnails if in production
  if (process.env.NODE_ENV === 'production') {
    const generator = new ThumbnailGenerator()
    console.log('Pre-warming thumbnail cache...')
    const result = await generator.scanAndGenerate()
    console.log(`Generated ${result.generated} thumbnails (${result.skipped} cached)`)
  }

  return httpServer
}
```

### Step 2: Client Panel Integration

#### Create Panel Mount Point

In your editor shell (`client/editor/EditorShell.js`):

```javascript
import { initializeModelBrowserPanel } from './ModelBrowserIntegration.js'
import { onPlaceModel } from './PlacementHandlers.js' // Your placement logic

function setupEditorPanels(editorContext) {
  // Create panel container
  const modelBrowserPanel = document.createElement('div')
  modelBrowserPanel.id = 'model-browser-panel'
  modelBrowserPanel.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'

  // Initialize browser with your placement handler
  const { browser, refresh, destroy } = initializeModelBrowserPanel(
    modelBrowserPanel,
    {
      placeModel: (modelConfig) => {
        onPlaceModel(modelConfig, editorContext)
      }
    }
  )

  // Mount panel to UI
  document.getElementById('panels-container').appendChild(modelBrowserPanel)

  // Store for cleanup
  editorContext._modelBrowser = { browser, refresh, destroy }
}

function cleanupEditorPanels(editorContext) {
  editorContext._modelBrowser?.destroy()
}
```

#### Placement Handler Example

Create `client/editor/PlacementHandlers.js`:

```javascript
export function onPlaceModel(modelConfig, editorContext) {
  const { modelPath, name, colliderType, scale } = modelConfig

  // Spawn entity at player position or default
  const position = editorContext.getPlayerPosition?.() || [0, 0, 0]

  // Use your existing entity spawn system
  editorContext.spawnEntity?.({
    type: 'model',
    modelPath,
    position,
    name: name || 'Placed Model',
    colliderType: colliderType || 'mesh',
    dynamic: false
  })

  // Show confirmation toast
  if (editorContext.showToast) {
    editorContext.showToast(`Placed "${name}"`)
  }
}
```

### Step 3: Add Panel to Editor UI

If using the editor shell with panel management:

```javascript
// In your editor panel initialization
ctx.editor.mountPanel({
  slot: 'left-panel',      // Or your panel slot
  label: 'Models',
  id: 'model-browser',
  render: (container) => {
    const { browser } = initializeModelBrowserPanel(container, {
      placeModel: (model) => handlePlaceModel(model)
    })
    return browser
  }
})
```

### Step 4: Add Styling (Optional)

Add to your editor CSS:

```css
.model-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-1, #1a1a1a);
}

.model-browser [class*="grid"] {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  padding: 8px;
}

.model-browser [class*="card"] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 6px;
  background: var(--bg-2, #222);
  cursor: pointer;
  transition: border-color 200ms;
}

.model-browser [class*="card"]:hover {
  border-color: var(--accent, #0066ff);
}

.model-browser img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 4px;
  background: var(--bg-3, #333);
}
```

## Advanced Configuration

### Custom Thumbnail Settings

```javascript
const generator = new ThumbnailGenerator({
  cacheDir: './custom-cache',
  glbDir: './custom-models',
  thumbSize: 512,        // Different size
  concurrency: 5         // More workers
})
```

### Model Filtering

Create custom filter in your editor:

```javascript
function getFilteredModels(allModels, filterFn) {
  return allModels.filter(filterFn)
}

const categorizedModels = getFilteredModels(
  modelCache,
  m => m.category === 'prop'
)
```

### Batch Operations

```javascript
import { generateThumbnails } from './ModelBrowserIntegration.js'

// Generate all missing thumbnails
const result = await generateThumbnails()
console.log(`Generated ${result.result.generated} thumbnails`)
```

## Testing Checklist

- [ ] Server starts without errors
- [ ] `/api/models` endpoint returns model list
- [ ] `/api/thumbnail/...` serves PNG images
- [ ] Model browser panel renders
- [ ] Search filters work
- [ ] Sort options work
- [ ] Preview opens and loads model
- [ ] 60 FPS orbit controls
- [ ] Place button calls handler
- [ ] No console errors

## Performance Tuning

### For Large Model Libraries (1000+)

1. **Pagination**:
```javascript
const ITEMS_PER_PAGE = 50
const totalPages = Math.ceil(models.length / ITEMS_PER_PAGE)
```

2. **Virtual Scrolling** (for list view):
```javascript
// Implement viewport-based rendering
// Only render visible items in large lists
```

3. **Lazy Thumbnail Loading**:
```javascript
// Images load only when scrolled into view
const observer = new IntersectionObserver(...)
```

### For Slow Hardware

1. Reduce thumbnail size (128x128)
2. Disable auto-rotate in preview
3. Limit grid columns to 2-3
4. Reduce animation frame rate

## Troubleshooting

### Issue: "/api/models returns 404"

**Solution**: Check route registration:
```javascript
// Verify in server startup
registerModelBrowserRoutes(httpServer, opts)
console.log('Model browser routes registered')
```

### Issue: "Thumbnails not generating"

**Solution**: Check canvas installation:
```bash
npm rebuild canvas
node -e "require('canvas')" # Should not error
```

### Issue: "Preview model doesn't load"

**Solution**: Check GLBLoader import:
```javascript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
```

### Issue: "Memory leak with many previews"

**Solution**: Ensure cleanup:
```javascript
viewer.dispose()  // Call when preview closes
previewInstances.clear()
```

## Monitoring

### Log Key Events

```javascript
// In ThumbnailGenerator
console.log(`Generating thumbnail for ${glbPath}`)
console.log(`Cached ${count} thumbnails, skipped ${skipped}`)

// In ModelBrowserHandler
console.log(`Listed ${models.length} models`)

// In ModelPreview
console.log(`Loaded model: ${modelPath}`)
```

### Metrics to Track

- Total models available
- Thumbnails cached vs. generated
- Average thumbnail load time
- Preview viewer frame rate
- Model placement success rate

## Future Integration Points

These are natural extensions to the system:

1. **Asset Upload UI**: Upload new GLBs directly
2. **Model Tagging**: User-created tags and collections
3. **Variant Management**: Show/manage model LOD variants
4. **Animation Browser**: List and preview model animations
5. **Material Editor**: Adjust material properties before placement
6. **Usage Analytics**: Track which models are placed most

## Files Modified/Created

### New Files Created

- `client/editor/ModelBrowser.js` - Main UI panel
- `client/editor/ModelBrowserIntegration.js` - Integration layer
- `client/ui/ModelPreview.js` - 3D viewer
- `src/editor/ThumbnailGenerator.js` - Thumbnail generation
- `src/editor/ThumbnailWorker.js` - Worker thread renderer
- `src/sdk/ModelBrowserHandler.js` - HTTP API
- `docs/MODEL_BROWSER.md` - Full documentation
- `MODEL_BROWSER_DEPS.md` - Dependency setup

### Files to Modify

- `src/index.server.js` - Add route registration
- `client/editor/EditorShell.js` - Mount browser panel
- `package.json` - Add `three` and `canvas` deps

## Next Steps

1. **Run tests**: Manual testing checklist above
2. **Gather feedback**: Show browser to designers/creators
3. **Refine UI**: Polish grid/list layouts
4. **Optimize**: Profile performance on your hardware
5. **Extend**: Add features from "Future Integration Points"

## Support

For issues or questions:

1. Check `docs/MODEL_BROWSER.md` for detailed API docs
2. Review implementation examples above
3. Check browser console for error messages
4. Test individual components in isolation
