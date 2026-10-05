export const ENGINE_ALIASES = Object.freeze({
  '@spoint/ecs': '/node_modules/@spoint/ecs/src/index.js',
  'three': '/node_modules/three/build/three.module.js'
})

const ALIAS_PATTERN = Object.keys(ENGINE_ALIASES).map(k => k.replaceAll('.', String.raw`\.`)).join('|')
const LOCAL_IMPORT = new RegExp(String.raw`((?:from|import)\s*)(['"])(\.[^'"]+|\/[^'"]+|` + ALIAS_PATTERN + String.raw`)\2`, 'g')

export function localSpecifiers(source) {
  const found = new Set()
  for (const m of source.matchAll(LOCAL_IMPORT)) if (!ENGINE_ALIASES[m[3]]) found.add(m[3])
  return [...found]
}

export function engineAliasUrls(origin) {
  return Object.fromEntries(Object.entries(ENGINE_ALIASES).map(([spec, path]) => [spec, origin + path]))
}

export function rewriteLocalSpecifiers(source, urlBySpecifier) {
  return source.replace(LOCAL_IMPORT, (whole, prefix, quote, specifier) =>
    urlBySpecifier[specifier] ? `${prefix}${quote}${urlBySpecifier[specifier]}${quote}` : whole
  )
}
