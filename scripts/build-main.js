// Bundles the Electron main process into one file, dist/main.bundle.js, from
// tsc's per-file output (dist/entry.js). dist/boot.js enables V8's compile
// cache and then requires it. The bundling itself is shared with ShowTrak
// Server (shared/scripts/build-main.js, which explains the arrangement); this
// names what Timers keeps external: sqlite3 (a native addon) and
// electron-updater (required on a packaged build's first update check).
const path = require('node:path');
const { createMainBundle } = require('../shared/scripts/build-main');

const Bundle = createMainBundle({
  root: path.resolve(__dirname, '..'),
  requiredExternals: ['sqlite3', 'electron-updater'],
});

module.exports = { mainBundleOptions: Bundle.mainBundleOptions, MAIN_BUNDLE: Bundle.MAIN_BUNDLE };

if (require.main === module) Bundle.main();
