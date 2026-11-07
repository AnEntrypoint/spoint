export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/node_modules/')) return next('file:///workspace/spoint' + specifier, context)
  if (context.parentURL && specifier.startsWith('file:///node_modules/')) return next('file:///workspace/spoint' + specifier.slice('file://'.length), context)
  if (specifier.startsWith('file:///node_modules/')) return next('file:///workspace/spoint/node_modules/' + specifier.slice('file:///node_modules/'.length), context)
  return next(specifier, context)
}
