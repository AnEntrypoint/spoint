// module.register spelling of the root-absolute specifier remap.
//
// Runs in the loader thread, so it cannot read in-thread witness state -- it resolves
// against the repo root derived from its own location, which is the only input the remap
// needs. Used where the running node has no in-process registerHooks (>=22.15): CI runs
// node 20. package.json declares engines.node ">=18", so this is the portable arm.
import { resolve } from './install-specifier-hooks.mjs'

export { resolve }
