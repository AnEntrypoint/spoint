export const STRINGS = {
  loadingConnecting: 'Connecting...',
  loadingEnvironment: 'Loading environment...',
  loadingSyncingServer: 'Syncing with server...',
  loadingStartingGame: 'Starting game...',
  loadingAnimations: 'Loading animations...',
  loadingWorld: 'Loading world...',

  connectionLostPermanent: 'Connection lost permanently. Please refresh the page.',
  connectionWaitingReconnect: 'Connection lost. Waiting to reconnect...',
  connectionOffline: 'offline',
  connectionReconnecting: (attempts) => `Reconnecting${attempts ? ' (attempt ' + attempts + ')' : ''}...`,
  connectionFailed: (msg) => 'Connection failed: ' + msg + ' -- reload to retry',

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
