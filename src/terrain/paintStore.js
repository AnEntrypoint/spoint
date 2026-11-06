import { createHostFieldPaint } from './fieldPaint.js'

export const PAINT_STORE_KEY = 'terrain-paint'

export async function restorePaintDocument(storage, terrainCfg) {
  const fieldPaint = createHostFieldPaint(terrainCfg)
  const saved = await storage.get(PAINT_STORE_KEY)
  if (saved === null || saved === undefined) return { fieldPaint, marks: terrainCfg?.marks }
  if (typeof saved !== 'object' || saved.paint === undefined) throw new TypeError('[terrain-paint] stored paint document is malformed')
  fieldPaint.fromJSON(saved.paint)
  return { fieldPaint, marks: terrainCfg?.marks ?? saved.marks ?? undefined }
}

export async function persistPaintDocument(storage, fieldPaint, marks) {
  await storage.set(PAINT_STORE_KEY, { paint: fieldPaint.toJSON(), marks: marks ?? null })
}
