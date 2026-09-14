const SHIP_APPROVAL_MARKER_FILE = '.gm/ship-approved';
const fs = require('fs');
return fs.existsSync(SHIP_APPROVAL_MARKER_FILE);
