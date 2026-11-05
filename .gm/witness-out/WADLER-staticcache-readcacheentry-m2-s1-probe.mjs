
import { readCacheEntry } from '/workspace/spoint/src/sdk/StaticCache.js';
const missing = readCacheEntry('/tmp/no-such-cache-file.bin', 'bin', 'stamp-1');
console.log(JSON.stringify({ missing }));