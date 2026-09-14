import { createHash } from 'node:crypto';

const _textureHashCache = new WeakMap();

function textureHash(tex) {
  if (!tex) return null;
  if (_textureHashCache.has(tex)) return _textureHashCache.get(tex);
  const img = tex.getImage();
  const hash = img && img.byteLength
    ? createHash('sha1').update(Buffer.isBuffer(img) ? img : Buffer.from(img.buffer, img.byteOffset, img.byteLength)).digest('hex')
    : null;
  _textureHashCache.set(tex, hash);
  return hash;
}

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

const IDENTITY_SKIPPED_ATTRIBUTES = new Set(['name', 'extras']);
const PROPERTY_TYPE_TEXTURE = 'Texture';

function literalSignature(value) {
  if (typeof value === 'number') return String(round(value));
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return `[${Array.from(value, (n) => (typeof n === 'number' ? round(n) : JSON.stringify(n))).join(',')}]`;
  return JSON.stringify(value);
}

function refSignature(child) {
  if (!child) return '-';
  if (child.propertyType === PROPERTY_TYPE_TEXTURE) return `tex(${textureHash(child) || 'empty'}|${child.getMimeType()})`;
  return `{${propertySignature(child)}}`;
}

function extensionsSignature(prop) {
  return prop.listExtensions()
    .map((ext) => `${ext.extensionName}{${propertySignature(ext)}}`)
    .sort()
    .join(',');
}

function propertySignature(prop) {
  const parts = [];
  for (const key of Object.keys(prop.getDefaults()).sort()) {
    if (IDENTITY_SKIPPED_ATTRIBUTES.has(key)) continue;
    if (key === 'extensions') { parts.push(`extensions:[${extensionsSignature(prop)}]`); continue; }
    const value = prop.get(key);
    const isRef = value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
    parts.push(`${key}:${isRef ? refSignature(prop.getRef(key)) : literalSignature(value)}`);
  }
  return parts.join('|');
}

function materialKey(material) {
  return propertySignature(material);
}

function materialConvergenceReport(doc) {
  const root = doc.getRoot();
  const materials = root.listMaterials();
  const textures = root.listTextures();
  const byKey = new Map();
  for (const mat of materials) {
    const key = materialKey(mat);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(mat);
  }
  const buckets = [...byKey.entries()].map(([key, mats]) => ({ key, count: mats.length, names: mats.map((m) => m.getName() || '(unnamed)') }));
  buckets.sort((a, b) => b.count - a.count);
  return {
    materialCount: materials.length,
    textureCount: textures.length,
    uniqueKeyCount: byKey.size,
    convergenceRatio: materials.length > 0 ? round(byKey.size / materials.length) : 1,
    trivialCollapseCandidates: materials.length - byKey.size,
    buckets,
  };
}

function collapseTrivialMaterialVariants(doc) {
  const root = doc.getRoot();
  const materials = root.listMaterials();
  const before = materials.length;
  const byKey = new Map();
  for (const mat of materials) {
    const key = materialKey(mat);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(mat);
  }
  let merged = 0;
  for (const mats of byKey.values()) {
    if (mats.length < 2) continue;
    const canonical = mats[0];
    for (let i = 1; i < mats.length; i++) {
      const dup = mats[i];
      for (const parent of dup.listParents()) {
        if (parent === root) continue;
        parent.swap(dup, canonical);
      }
      dup.dispose();
      merged++;
    }
  }
  return { merged, remaining: before - merged };
}

function corpusMaterialConvergence(assetReports) {
  const byKey = new Map();
  const keyCount = new Map();
  for (const { name, report } of assetReports) {
    for (const bucket of report.buckets) {
      if (!byKey.has(bucket.key)) byKey.set(bucket.key, new Set());
      byKey.get(bucket.key).add(name);
      keyCount.set(bucket.key, (keyCount.get(bucket.key) || 0) + bucket.count);
    }
  }
  const crossAssetBuckets = [...byKey.entries()]
    .filter(([, assets]) => assets.size > 1)
    .map(([key, assets]) => ({ key, assetCount: assets.size, assets: [...assets], materialInstances: keyCount.get(key) }))
    .sort((a, b) => b.assetCount - a.assetCount);

  const totalMaterials = assetReports.reduce((s, a) => s + a.report.materialCount, 0);
  const totalUniqueKeys = byKey.size;
  return {
    assetCount: assetReports.length,
    totalMaterials,
    totalUniqueKeys,
    corpusConvergenceRatio: totalMaterials > 0 ? round(totalUniqueKeys / totalMaterials) : 1,
    crossAssetBuckets,
  };
}

const MATERIAL_BUCKET_EXTRAS_KEY = 'EP_material_bucket';

function stampMaterialBucketKeys(doc) {
  const root = doc.getRoot();
  const byMaterial = new Map();
  for (const mat of root.listMaterials()) {
    const key = materialKey(mat);
    const hash = createHash('sha1').update(key).digest('hex');
    const extras = mat.getExtras() || {};
    extras[MATERIAL_BUCKET_EXTRAS_KEY] = hash;
    mat.setExtras(extras);
    byMaterial.set(mat, hash);
  }
  return byMaterial;
}

export {
  materialKey,
  textureHash,
  materialConvergenceReport,
  collapseTrivialMaterialVariants,
  corpusMaterialConvergence,
  stampMaterialBucketKeys,
  MATERIAL_BUCKET_EXTRAS_KEY,
};
