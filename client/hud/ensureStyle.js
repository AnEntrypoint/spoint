export function ensureStyle(id, css) {
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}

const _hotSwapensureStyle = (next) => {
  ensureStyle = next.ensureStyle
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapensureStyle)
