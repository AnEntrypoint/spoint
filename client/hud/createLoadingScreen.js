import { renderLoadingScreen } from 'anentrypoint-design'

// View comes from the anentrypoint-design loading-screen kit (consumed from
// unpkg via the importmap). This module owns only the LoadingManager event
// wiring; the kit owns the overlay layout, bars, and classes.
export function createLoadingScreen(loadingManager) {
  const kit = renderLoadingScreen({ brand: 'Spoint', label: 'Connecting...' })
  document.body.insertBefore(kit.node, document.body.firstChild)

  loadingManager.addEventListener('download', (e) => {
    const { percent, done, total } = e.detail
    kit.setDownload(percent)
    if (total > 0) kit.setDetail(`${done} / ${total} assets`)
  })

  loadingManager.addEventListener('processing', (e) => {
    const { percent, done, total } = e.detail
    kit.setProcessing(percent)
    if (total > 0) kit.setDetail(`Compiling shaders ${done} / ${total}`)
  })

  loadingManager.addEventListener('label', (e) => {
    kit.setLabel(e.detail.label)
  })

  return {
    element: kit.node,
    setLabel: (text) => kit.setLabel(text),
    hide: () => kit.hide(),
    dispose: () => kit.dispose(),
  }
}
