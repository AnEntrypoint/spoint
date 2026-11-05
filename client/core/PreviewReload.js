const MANIFEST_URL = './__preview.json'
const POLL_MS = 1000

export function startPreviewReload({ url = MANIFEST_URL, pollMs = POLL_MS, reload = () => location.reload(), fetchImpl = fetch, setTimer = setInterval } = {}) {
  let seen = null
  let inFlight = false
  const tick = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const res = await fetchImpl(`${url}?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const { build } = await res.json()
      if (seen === null) seen = build
      else if (build !== seen) reload()
    } catch {
    } finally {
      inFlight = false
    }
  }
  tick()
  return setTimer(tick, pollMs)
}
