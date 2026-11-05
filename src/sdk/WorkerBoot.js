try {
  await import('./WorkerEntry.js')
} catch (err) {
  self.postMessage({
    type: 'BOOT_ERROR',
    message: err?.message || String(err),
    stack: err?.stack || null,
  })
}
