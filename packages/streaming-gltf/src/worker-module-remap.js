const STATIC_IMPORT_SPECIFIER = /(?<=^|;)(\s*(?:import\s*|import\b[^'"`;()]*?\bfrom\s*|export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}'"`]*\})\s*from\s*))(['"])([^'"\r\n]+)\2/gm;

const isRelativeSpecifier = (s) => s.startsWith('./') || s.startsWith('../') || s.startsWith('/');

async function remapModule(url, bareMap, cache, chain, blobUrls) {
  if (chain.includes(url)) throw new Error(`worker-module-remap: import cycle ${[...chain, url].join(' -> ')}`);
  if (cache.has(url)) return cache.get(url);
  const pending = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`worker-module-remap: fetch ${url}: ${res.status}`);
    const src = await res.text();
    const matches = [...src.matchAll(STATIC_IMPORT_SPECIFIER)];
    const targets = await Promise.all(matches.map(([, , , spec]) => {
      if (Object.hasOwn(bareMap, spec)) return bareMap[spec];
      if (isRelativeSpecifier(spec)) return remapModule(new URL(spec, url).href, bareMap, cache, [...chain, url], blobUrls);
      return spec;
    }));
    if (matches.every(([, , , spec], i) => targets[i] === spec || (isRelativeSpecifier(spec) && targets[i] === new URL(spec, url).href))) return url;
    let out = '';
    let cursor = 0;
    matches.forEach((m, i) => {
      const specStart = m.index + m[1].length + 1;
      out += src.slice(cursor, specStart) + targets[i];
      cursor = specStart + m[3].length;
    });
    out += src.slice(cursor);
    const blobUrl = URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
    blobUrls.push(blobUrl);
    return blobUrl;
  })();
  cache.set(url, pending);
  return pending;
}

export async function importWithBareRemap(url, bareMap) {
  const blobUrls = [];
  try {
    return await import(await remapModule(url, bareMap, new Map(), [], blobUrls));
  } finally {
    for (const b of blobUrls) URL.revokeObjectURL(b);
  }
}
