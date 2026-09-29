export const editorKit = import('game-editor-kit').catch((e) => {
  const reason = 'game-editor-kit load failed: ' + (e?.message || e)
  window.__kitWiringError = ((window.__kitWiringError || '') + ' ' + reason).trim()
  console.error('[kit]', reason)
  return null
})
