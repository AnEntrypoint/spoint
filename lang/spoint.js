'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  id: 'spoint',
  exec: {
    match: /^exec:spoint/,
    run(code, cwd) {
      const tmpFile = path.join(os.tmpdir(), 'spoint-exec-' + Date.now() + '.mjs');
      try {
        fs.writeFileSync(tmpFile, code, 'utf8');
        return execFileSync('node', [tmpFile], {
          cwd: 'C:/dev/devbox/spawnpoint',
          encoding: 'utf8',
          timeout: 25000
        });
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
  },
  context: `=== spoint exec ===\nexec:spoint\n<code>\n\nRuns Node.js in spawnpoint CWD (C:/dev/devbox/spawnpoint). Import server modules via dynamic import('/abs/path'). Use for server validation, entity inspection, physics tests.`
};
