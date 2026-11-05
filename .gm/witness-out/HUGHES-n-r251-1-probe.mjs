import { join, resolve, sep } from 'node:path';
const dir = '/srv/root/apps';
const decide = (rel) => { const srcPath = join(dir, rel); return resolve(srcPath).startsWith(resolve(dir) + sep); };
console.log(JSON.stringify({ legit: decide('/tank/a.glb'), traversal: decide('/../../etc/secret.glb'), nested: decide('/x/../tank/a.glb') }));