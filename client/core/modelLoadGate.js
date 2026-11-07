import { modelLoadRefusal, refuseModelLoad, recordModelLoadError } from '../../src/shared/modelLoadErrors.js'
export { modelLoadRefusal, refuseModelLoad, recordModelLoadError, takeModelLoadErrors, modelLoadErrorCount, shouldSendEnvironmentDone } from '../../src/shared/modelLoadErrors.js'

function refusal(reasonCode, message) {
  const err = new TypeError(`[model-load] ${message}`)
  err.reasonCode = reasonCode
  return err
}

export async function prefetchModel(url, load) {
  if (typeof url !== 'string' || !url) throw refusal('model-prefetch-url-invalid', 'url must be a non-empty string')
  if (typeof load !== 'function') throw refusal('model-prefetch-load-invalid', 'load must be a function')
  try {
    return await load(url)
  } catch (cause) {
    throw refuseModelLoad(url, cause)
  }
}

export async function runModelLoadGate({ urls = [], prefetch, sendMark, onFailure = null } = {}) {
  if (!Array.isArray(urls)) throw refusal('model-gate-urls-invalid', 'urls must be an array')
  if (typeof prefetch !== 'function' || typeof sendMark !== 'function') throw refusal('model-gate-hooks-invalid', 'prefetch and sendMark must be functions')
  if (onFailure !== null && typeof onFailure !== 'function') throw refusal('model-gate-failure-hook-invalid', 'onFailure must be a function or null')
  if (urls.length === 0) {
    sendMark('MODELS_DONE')
    return { ok: true, loaded: 0, mark: 'MODELS_DONE' }
  }
  try {
    await prefetch(urls)
  } catch (cause) {
    const err = cause?.reasonCode === 'model-load-failed' ? recordModelLoadError(cause) : refuseModelLoad(cause?.url ?? urls[0], cause)
    console.error('[model-load]', err.reasonCode, err.url, err.message)
    if (onFailure) onFailure(err)
    return { ok: false, refusal: err, mark: null }
  }
  sendMark('MODELS_DONE')
  return { ok: true, loaded: urls.length, mark: 'MODELS_DONE' }
}
