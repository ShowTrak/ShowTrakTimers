// Concatenates the CSS parts (src/UI/css/parts/*.css, in file-name order) into
// src/UI/css/main.css, which copy-assets.js ships to dist/UI/css/main.css for
// the desktop window and the Web Dashboard (shared/scripts/build-css.js).
//
// The 0* parts are ShowTrak Server's (copied in by scripts/sync-server-css.js);
// 10-timers.css is this app's. Edit the parts, NOT main.css: it is regenerated
// on every build.
const path = require('node:path');

require('../shared/scripts/build-css').buildCss({ root: path.resolve(__dirname, '..') });
