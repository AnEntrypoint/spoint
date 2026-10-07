import { gpuArgs, gpuModeOf, gpuLaunchArgs, vendorGpuArgs, directxAdapters } from './gpu-probe.mjs'

export function vendorLaunchArgs(mode, extra = []) {
  const want = gpuModeOf(mode)
  if (!want.accelerated) return [...gpuLaunchArgs(want), ...extra]
  if (!want.vendor) return [...gpuArgs({ accelerated: true }), ...extra]
  try {
    return [...gpuArgs({ accelerated: true }), ...vendorGpuArgs(want.vendor), ...extra]
  } catch (e) {
    console.error(`[witness-gpu] gpu arm "${want.mode}" has no adapter to run on: ${e.message}; DirectX adapters this box reports: ${JSON.stringify(directxAdapters())}`)
    process.exit(2)
  }
}

export function vendorPinArgs(vendor) {
  try {
    return vendorGpuArgs(vendor)
  } catch (e) {
    console.error(`[witness-gpu] gpu arm "${vendor}" has no adapter to run on: ${e.message}; DirectX adapters this box reports: ${JSON.stringify(directxAdapters())}`)
    process.exit(2)
  }
}

export function gpuArmTag(mode, rasterizer) {
  const want = gpuModeOf(mode)
  return `gpuMode=${want.mode} rasterizer=${rasterizer || 'unknown'}`
}
