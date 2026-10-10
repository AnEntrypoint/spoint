export async function isXRSessionSupported(mode) {
  if (!navigator.xr) return false
  return navigator.xr.isSessionSupported(mode)
}
