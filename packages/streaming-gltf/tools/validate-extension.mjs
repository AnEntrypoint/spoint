#!/usr/bin/env node
// Conformance validator for the EP_progressive_lod glTF extension.
//
// Usage:
//   node tools/validate-extension.mjs <model.glb>
//
// Reads the GLB's JSON chunk, locates extensions.EP_progressive_lod (or the
// legacy extras.LOCAL_progressive fallback), and validates it against the JSON
// Schema under extensions/EP_progressive_lod/schema/. If `ajv` is installed
// it is used for full draft-07 validation; otherwise the tool falls back to a
// dependency-free structural check so it still runs in a bare checkout.
//
// Exit code 0 = conformant, 1 = non-conformant or no payload found.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(repoRoot, 'extensions/EP_progressive_lod/schema');

function extractGlbJson(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('expected JSON chunk first');
  const bytes = new Uint8Array(glb.buffer, glb.byteOffset + 20, jsonLen);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadSchemas() {
  const names = [
    'glTF.EP_progressive_lod.schema.json',
    'mesh.EP_progressive_lod.schema.json',
    'texture.EP_progressive_lod.schema.json',
    'lod.EP_progressive_lod.schema.json',
  ];
  const schemas = {};
  for (const n of names) {
    schemas[n] = JSON.parse(await readFile(path.join(SCHEMA_DIR, n), 'utf8'));
  }
  return schemas;
}

async function tryAjv(schemas, payload) {
  let Ajv;
  try {
    ({ default: Ajv } = await import('ajv'));
  } catch {
    return null; // ajv not installed
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  // Register sub-schemas under their $ref filenames.
  for (const [name, schema] of Object.entries(schemas)) {
    if (name !== 'glTF.EP_progressive_lod.schema.json') ajv.addSchema(schema, name);
  }
  const validate = ajv.compile(schemas['glTF.EP_progressive_lod.schema.json']);
  const ok = validate(payload);
  return { ok, errors: validate.errors || [] };
}

function structuralCheck(payload) {
  const errors = [];
  if (typeof payload.version !== 'number') errors.push('version: missing or not a number');
  if (!['sibling-file', 'single-glb-range'].includes(payload.storage)) {
    errors.push(`storage: must be "sibling-file" or "single-glb-range" (got ${JSON.stringify(payload.storage)})`);
  }
  if (!Array.isArray(payload.meshes)) {
    errors.push('meshes: missing or not an array');
  } else {
    payload.meshes.forEach((m, i) => {
      if (typeof m.meshIndex !== 'number') errors.push(`meshes[${i}].meshIndex: missing`);
      if (typeof m.primIndex !== 'number') errors.push(`meshes[${i}].primIndex: missing`);
      if (!Array.isArray(m.lods) || m.lods.length < 1) errors.push(`meshes[${i}].lods: must be a non-empty array`);
      else m.lods.forEach((l, j) => {
        if (typeof l.ratio !== 'number' || l.ratio <= 0 || l.ratio > 1) {
          errors.push(`meshes[${i}].lods[${j}].ratio: must be in (0,1]`);
        }
      });
    });
  }
  if (payload.textures != null && !Array.isArray(payload.textures)) errors.push('textures: not an array');
  return { ok: errors.length === 0, errors };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node tools/validate-extension.mjs <model.glb>');
    process.exit(2);
  }
  const glb = new Uint8Array(await readFile(input));
  const json = extractGlbJson(glb);
  const payload = json.extensions?.EP_progressive_lod ?? json.extras?.LOCAL_progressive;
  if (!payload) {
    console.error(`[validate] no EP_progressive_lod payload found in ${input}`);
    process.exit(1);
  }
  const legacy = !json.extensions?.EP_progressive_lod;
  if (legacy) console.warn('[validate] WARNING: payload found under legacy extras.LOCAL_progressive — re-bake to emit extensions.EP_progressive_lod');
  if (!legacy && !(json.extensionsUsed || []).includes('EP_progressive_lod')) {
    console.warn('[validate] WARNING: EP_progressive_lod not declared in extensionsUsed');
  }

  const schemas = await loadSchemas();
  let result = await tryAjv(schemas, payload);
  const mode = result ? 'ajv (draft-07)' : 'structural (ajv not installed)';
  if (!result) result = structuralCheck(payload);

  if (result.ok) {
    console.log(`[validate] OK — ${input} conforms to EP_progressive_lod [${mode}, storage=${payload.storage}]`);
    process.exit(0);
  }
  console.error(`[validate] FAIL — ${input} [${mode}]`);
  for (const e of result.errors) console.error('  -', typeof e === 'string' ? e : `${e.instancePath || '/'} ${e.message}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

export { extractGlbJson, structuralCheck };
