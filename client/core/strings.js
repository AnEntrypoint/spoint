// i18n-string-table-pass: flat key -> English string lookup table. Minimal extraction of
// representative HUD/lobby/editor-toast strings that were previously inline literals, as a
// first step toward locale support (a future locale swap only needs to replace this module's
// export, no call-site changes). Not a full i18n framework (no interpolation/pluralization
// engine) -- callers that need a value in the middle of a string still build it themselves,
// e.g. STRINGS.editorCameraBookmarkSaved(slot) below for the handful of toasts that need one.
export const STRINGS = {
  // Loading screen / LoadingMachine.js labels
  loadingConnecting: 'Connecting...',
  loadingEnvironment: 'Loading environment...',
  loadingSyncingServer: 'Syncing with server...',
  loadingStartingGame: 'Starting game...',
  loadingAnimations: 'Loading animations...',
  loadingWorld: 'Loading world...',

  // ConnectionStatus.js banner/HUD chip
  connectionLostPermanent: 'Connection lost permanently. Please refresh the page.',
  connectionWaitingReconnect: 'Connection lost. Waiting to reconnect...',
  connectionOffline: 'offline',
  connectionReconnecting: (attempts) => `Reconnecting${attempts ? ' (attempt ' + attempts + ')' : ''}...`,
  connectionFailed: (msg) => 'Connection failed: ' + msg + ' -- reload to retry',

  // Editor toasts (client/editor/editor.js)
  editorNoEntitySelected: 'No entity selected',
  editorEntityCopied: 'Copied entity',
  editorEntityPasted: 'Pasted onto entity',
  editorClipboardEmpty: 'Clipboard empty',
  editorCameraBookmarkSaved: (slot) => 'Camera bookmark ' + slot + ' saved',
  editorCameraBookmarkRecalled: (slot) => 'Camera bookmark ' + slot + ' recalled',
  editorCameraBookmarkMissing: (slot) => 'No camera bookmark in slot ' + slot,
  editorEntitiesDeleted: (n) => 'Deleted ' + n + ' entities',
  editorUploadingFile: (name) => 'Uploading ' + name + '...',
  editorFilePlaced: (name) => 'Placed ' + name,
  editorUploadFailed: (reason) => 'Upload failed: ' + reason,
  editorScatterCopy: 'copy',
  editorScatterCopies: 'copies',
}

export default STRINGS
