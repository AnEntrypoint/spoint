export async function isXRSessionSupported(mode) {
  if (!navigator.xr) return false
  return navigator.xr.isSessionSupported(mode)
}

const _hotSwapExports = (next) => {
  isXRSessionSupported = next.isXRSessionSupported
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapExports)
