import * as THREE from 'three'
import { get, put } from './IndexedDBStore.js'

const DB_NAME = 'spawnpoint-geometry-cache'
const DB_VERSION = 1
const STORE = 'geometry'

function _serializeAttribute(attr) {
  return {
    name: attr.name,
    array: attr.array.buffer.slice(attr.array.byteOffset, attr.array.byteOffset + attr.array.byteLength),
    itemSize: attr.itemSize,
    normalized: attr.normalized,
    type: attr.array.constructor.name
  }
}

function _serializeMesh(mesh) {
  const geo = mesh.geometry
  const attrs = {}
  for (const [name, attr] of Object.entries(geo.attributes)) {
    try { attrs[name] = _serializeAttribute(attr) } catch { }
  }
  const index = geo.index
    ? geo.index.array.buffer.slice(geo.index.array.byteOffset, geo.index.array.byteOffset + geo.index.array.byteLength)
    : null
  const indexType = geo.index ? geo.index.array.constructor.name : null
  const mat = mesh.material
  return {
    name: mesh.name,
    attrs,
    index,
    indexType,
    drawRange: { start: geo.drawRange.start, count: geo.drawRange.count },
    matName: mat?.name || '',
    matColor: mat?.color?.getHex?.() ?? 0xffffff,
    matRoughness: mat?.roughness ?? 1,
    matMetalness: mat?.metalness ?? 0,
    matTransparent: mat?.transparent ?? false,
    matOpacity: mat?.opacity ?? 1,
    position: [mesh.position.x, mesh.position.y, mesh.position.z],
    quaternion: [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
    scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
    castShadow: mesh.castShadow,
    receiveShadow: mesh.receiveShadow,
    visible: mesh.visible,
    matrixAutoUpdate: mesh.matrixAutoUpdate
  }
}

const TYPE_MAP = { Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array }

function _deserializeAttribute(data) {
  const TypedArray = TYPE_MAP[data.type] || Float32Array
  return { array: new TypedArray(data.array), itemSize: data.itemSize, normalized: data.normalized }
}

export async function getGeometry(url) {
  try {
    const cached = await get(DB_NAME, DB_VERSION, STORE, url)
    return cached?.meshes ?? null
  } catch { return null }
}

export async function storeGeometry(url, meshes) {
  try {
    const serialized = []
    for (const mesh of meshes) {
      try { serialized.push(_serializeMesh(mesh)) } catch { }
    }
    if (serialized.length > 0) await put(DB_NAME, DB_VERSION, STORE, url, { meshes: serialized })
  } catch { }
}

export function reconstructGeometry(data) {
  const geo = new THREE.BufferGeometry()
  for (const [name, attrData] of Object.entries(data.attrs)) {
    const { array, itemSize, normalized } = _deserializeAttribute(attrData)
    geo.setAttribute(name, new THREE.BufferAttribute(array, itemSize, normalized))
  }
  if (data.index) {
    const TypedArray = TYPE_MAP[data.indexType] || Uint16Array
    geo.setIndex(new THREE.BufferAttribute(new TypedArray(data.index), 1))
  }
  if (data.drawRange) geo.setDrawRange(data.drawRange.start, data.drawRange.count)
  return geo
}

export async function getLodIndex(url, level) {
  try {
    const cached = await get(DB_NAME, DB_VERSION, STORE, `${url}:lod${level}`)
    return cached?.index ?? null
  } catch { return null }
}

export async function storeLodIndex(url, level, indexArray) {
  try {
    const buf = indexArray.buffer.slice(indexArray.byteOffset, indexArray.byteOffset + indexArray.byteLength)
    await put(DB_NAME, DB_VERSION, STORE, `${url}:lod${level}`, { index: buf, type: indexArray.constructor.name })
  } catch { }
}

export function reconstructLodIndex(cached) {
  if (!cached?.index) return null
  const TypedArray = TYPE_MAP[cached.type] || Uint32Array
  return new TypedArray(cached.index)
}
