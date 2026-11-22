// Copies the static runtime assets TypeScript does not compile (the renderer's
// markup, CSS, audio and vendors, the Web Dashboard page, the images) into
// dist/, so __dirname-relative paths in the main process resolve as in src/.
// shared/scripts/copy-assets.js does the copying, as for ShowTrak Server,
// never over a bundle that scripts/build-renderer.js wrote.
const path = require('node:path');
const { createAssetCopy } = require('../shared/scripts/copy-assets');
const { BUNDLES } = require('./build-renderer');

const Assets = createAssetCopy({
  root: path.resolve(__dirname, '..'),
  // Folders under src/ copied wholesale. Keep in step with the `exclude` globs
  // in tsconfig.json.
  directories: ['UI', 'WebDashboard', 'images'],
  bundles: BUNDLES,
});

module.exports = {
  ASSET_DIRECTORIES: Assets.directories,
  skipDirs: Assets.skipDirs,
  skipFiles: Assets.skipFiles,
};

if (require.main === module) Assets.main();
