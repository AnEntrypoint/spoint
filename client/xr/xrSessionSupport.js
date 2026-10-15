export async function isXRSessionSupported(mode) {
  if (!navigator.xr) return false
  return navigator.xr.isSessionSupported(mode)
}

// --- hot swap -----
// An edit here is accepted by this module: every export is re-assigned to the freshly imported copy,
// so importers already holding the live binding read the edited code without a page reload.
const _hotSwapExports = (next) => {
  isXRSessionSupported = next.isXRSessionSupported
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapExports)
