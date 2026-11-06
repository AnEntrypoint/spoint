const _errors = []

export function modelLoadRefusal(url, cause) {
  const err = new Error(`[model-load] ${url}: ${cause?.message ?? cause}`)
  err.reasonCode = 'model-load-failed'
  err.url = url
  if (cause) err.cause = cause
  return err
}

export function recordModelLoadError(refusal) {
  const err = refusal?.reasonCode === 'model-load-failed' ? refusal : modelLoadRefusal(refusal?.url ?? '<unknown>', refusal)
  _errors.push(err)
  return err
}

export function refuseModelLoad(url, cause) {
  return recordModelLoadError(modelLoadRefusal(url, cause))
}

export function takeModelLoadErrors() {
  return _errors.splice(0)
}

export function modelLoadErrorCount() {
  return _errors.length
}

export async function loadPlacedModelRecords({ access, readFile, fp }) {
  if (typeof access !== 'function' || typeof readFile !== 'function' || typeof fp !== 'string') {
    throw modelLoadRefusal(String(fp), new TypeError('access, readFile and fp are required'))
  }
  try {
    await access(fp)
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw refuseModelLoad(fp, cause)
  }
  try {
    return JSON.parse(await readFile(fp, 'utf-8'))
  } catch (cause) {
    throw refuseModelLoad(fp, cause)
  }
}

export function loadPrefabRecords({ existsSync, readFileSync, path }) {
  if (typeof existsSync !== 'function' || typeof readFileSync !== 'function' || typeof path !== 'string') {
    throw modelLoadRefusal(path, new TypeError('existsSync, readFileSync and path are required'))
  }
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw refuseModelLoad(path, cause)
  }
}

export function createModelErrorHandler({ onError = null } = {}) {
  if (onError !== null && typeof onError !== 'function') {
    throw modelLoadRefusal('<handler>', new TypeError('onError must be a function or null'))
  }
  const errors = []
  return {
    errors,
    onError(url) {
      const err = refuseModelLoad(url, new Error('loader failed'))
      errors.push(err)
      if (onError) onError(err)
      return err
    },
  }
}

export function shouldSendEnvironmentDone(failed, isEnv, anyEntityDone) {
  return !failed && (isEnv || !anyEntityDone)
}
