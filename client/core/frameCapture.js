export async function captureHudFreeFrame({ renderer, scene, camera, hudElements = [], type = 'image/png', quality }) {
  const canvas = renderer.domElement
  const saved = hudElements.map((el) => [el, el.style.visibility])
  for (const [el] of saved) el.style.visibility = 'hidden'
  try {
    renderer.render(scene, camera)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality))
    if (!blob) throw new Error('capture_unavailable')
    return blob
  } finally {
    for (const [el, value] of saved) el.style.visibility = value
  }
}
