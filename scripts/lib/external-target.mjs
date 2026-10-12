import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CHECKOUT_ENV = 'GM_CHECKOUT';

export function flagValue(argv, name) {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

export function positionalArg(argv) {
  return argv.find((arg) => !arg.startsWith('-'));
}

const how = (spec) =>
  `pass --${spec.flagName}=<path>, set ${spec.envName}, or set ${CHECKOUT_ENV}=<gm checkout root> so ${spec.underCheckout} resolves inside it`;

const configured = (spec, argv) => {
  const flag = spec.flag ?? flagValue(argv, spec.flagName);
  if (typeof flag === 'string' && flag !== '') return { path: resolve(flag), source: `--${spec.flagName}` };
  const env = process.env[spec.envName];
  if (typeof env === 'string' && env !== '') return { path: resolve(env), source: `${spec.envName}` };
  const checkout = process.env[CHECKOUT_ENV];
  if (typeof checkout === 'string' && checkout !== '') {
    return { path: resolve(join(checkout, spec.underCheckout)), source: `${CHECKOUT_ENV}=${checkout} plus ${spec.underCheckout}` };
  }
  return null;
};

export function requireExternalTarget(spec) {
  const argv = spec.argv ?? [];
  const found = configured(spec, argv);
  if (found === null) {
    console.log(`witness: ${spec.witness}`);
    console.log('target: none');
    console.log(`SKIP: no ${spec.label} is reachable on this machine; ${how(spec)}`);
    console.log('RESULT: SKIP');
    process.exit(0);
  }
  if (!existsSync(found.path)) {
    console.log(`witness: ${spec.witness}`);
    console.log(`target: ${found.path}`);
    console.log(`REFUSE: ${spec.label} is absent at ${found.path}, resolved from ${found.source}; ${how(spec)}`);
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  return found;
}
