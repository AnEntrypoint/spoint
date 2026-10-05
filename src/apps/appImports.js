const LOCAL_IMPORT = /((?:from|import)\s*)(['"])(\.[^'"]+|\/[^'"]+)\2/g

export function localSpecifiers(source) {
  const found = new Set()
  for (const m of source.matchAll(LOCAL_IMPORT)) found.add(m[3])
  return [...found]
}

export function rewriteLocalSpecifiers(source, urlBySpecifier) {
  return source.replace(LOCAL_IMPORT, (whole, prefix, quote, specifier) =>
    urlBySpecifier[specifier] ? `${prefix}${quote}${urlBySpecifier[specifier]}${quote}` : whole
  )
}
