const REPO_ROOT = new URL('../../', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/src/')) {
    return { url: new URL(specifier.slice(1), REPO_ROOT).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
