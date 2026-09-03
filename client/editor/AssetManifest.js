export const ASSET_HOST = 'https://anentrypoint.github.io/assets/'

let _manifestPromise = null

export function fetchAssetManifest() {
  if (!_manifestPromise) {
    _manifestPromise = fetch(`${ASSET_HOST}manifest.json`, { cache: 'no-store' })
      .then(res => { if (!res.ok) throw new Error(`manifest ${res.status}`); return res.json() })
      .catch(e => { _manifestPromise = null; throw e })
  }
  return _manifestPromise
}
