import { createPerformanceProfiler } from './PerformanceProfiler.js'
import { createNetworkInspector } from '../ui/NetworkInspector.js'
import { createDevDashboard } from '../ui/DevDashboard.js'

const GPU_MS_PER_DRAW_CALL_ESTIMATE = 0.01

export function installDevTools(renderer, scene, networkClient) {
  if (typeof window === 'undefined') return { profiler: null, network: null, dashboard: null }

  const profiler = createPerformanceProfiler(renderer, scene)
  const networkInspector = createNetworkInspector(networkClient)
  const dashboard = createDevDashboard(profiler, networkInspector)

  profiler.install()
  networkInspector.install()
  dashboard.install()

  let lastCpuTime = 0
  let lastGpuTime = 0

  const frameUpdateHook = () => {
    if (profiler) {
      const gpuEstimate = renderer?.info?.render?.calls ? (renderer.info.render.calls * GPU_MS_PER_DRAW_CALL_ESTIMATE) : 0
      profiler.update(lastCpuTime, gpuEstimate)
    }

    if (networkInspector) {
      networkInspector.update()
    }

    if (dashboard) {
      dashboard.update()
    }
  }

  window.__devToolsUpdate = frameUpdateHook

  window.__devTools = {
    profiler,
    network: networkInspector,
    dashboard,
    setFrameMetrics(cpuMs, gpuMs) {
      lastCpuTime = cpuMs
      lastGpuTime = gpuMs
    },
  }

  return { profiler, networkInspector, dashboard }
}

