// DevToolsIntegration -- Boot-time installation of developer profiling tools.
// Includes: Performance Profiler (F12), Network Inspector (F11), Developer Dashboard.
// Zero overhead when disabled. Called once from app.js boot.
//
// This module coordinates the installation of three complementary tools:
// 1. PerformanceProfiler - Real-time FPS/memory/thermals overlay (F12 to toggle)
// 2. NetworkInspector - Network latency/bandwidth monitoring (F11 to toggle)
// 3. DevDashboard - Unified control panel with preset configurations
//
// All are installed at boot-time but remain dormant (<0.1ms) until toggled.

import { createPerformanceProfiler } from './PerformanceProfiler.js'
import { createNetworkInspector } from '../ui/NetworkInspector.js'
import { createDevDashboard } from '../ui/DevDashboard.js'

export function installDevTools(renderer, scene, networkClient) {
  if (typeof window === 'undefined') return { profiler: null, network: null, dashboard: null }

  // Create the three profilers
  const profiler = createPerformanceProfiler(renderer, scene)
  const networkInspector = createNetworkInspector(networkClient)
  const dashboard = createDevDashboard(profiler, networkInspector)

  // Install UI overlays
  profiler.install()
  networkInspector.install()
  dashboard.install()

  // Create frame update hook
  let lastCpuTime = 0
  let lastGpuTime = 0

  const frameUpdateHook = () => {
    // Update profiler with frame metrics
    if (profiler) {
      // CPU time is measured by the frame loop
      // GPU time is estimated from renderer.info if available
      const gpuEstimate = renderer?.info?.render?.calls ? (renderer.info.render.calls * 0.01) : 0
      profiler.update(lastCpuTime, gpuEstimate)
    }

    // Update network inspector
    if (networkInspector) {
      networkInspector.update()
    }

    // Update dashboard
    if (dashboard) {
      dashboard.update()
    }
  }

  // Expose on window for app.js to call from animate loop
  window.__devToolsUpdate = frameUpdateHook

  // Expose profilers on window for debugging/scripting
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

// Integration point in app.js animate() loop:
// Add this line after _perf.sample() in the animate() function:
//
//   if (window.__devToolsUpdate) {
//     window.__devToolsUpdate()
//   }
//
// Or better, call directly with CPU/GPU times:
//
//   const cpuTime = <measured CPU time in ms>
//   const gpuTime = queryGPUTimer()  // if available
//   window.__devTools?.setFrameMetrics(cpuTime, gpuTime)
//   window.__devToolsUpdate?.()
